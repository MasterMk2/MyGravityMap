import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  AttributionControl,
} from 'maplibre-gl'
import type { FitBoundsOptions, FlyToOptions, MapOptions } from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import type { Deck, Layer } from '@deck.gl/core'
import { BASEMAPS, attributionOf } from './basemaps'
import type { BasemapId } from './basemaps'
import { buildBuildingsLayer } from './buildings'
import { ensureMaplibreWorker } from './maplibreWorker'
import { startRecording, type Recording } from './recorder'
import { supportsWebGL2, type MapSession, type MapStatus } from './mapSession'
import { mountMap } from './mapLifecycle'
import { MapStatusNotice } from './MapStatusNotice'
import './MapCanvas.css'

export interface MapCanvasViewState {
  longitude: number
  latitude: number
  zoom: number
}

export interface MapCanvasInitialViewState {
  longitude: number
  latitude: number
  zoom: number
  pitch?: number
  bearing?: number
}

export interface MapCanvasProps {
  /** deck.gl layers. re-rendered (via overlay.setProps) whenever this changes */
  layers: Layer[]
  /** Pauses rendering-dependent app activity when an attempt fails. */
  onAvailabilityChange?: (available: boolean) => void
  /** default 'dark' */
  basemap?: BasemapId
  initialViewState?: MapCanvasInitialViewState
  onViewStateChange?: (v: MapCanvasViewState) => void
  /** rendered as an absolutely-positioned overlay above the map (for HUD/controls) */
  children?: ReactNode
  /**
   * 地図（ベースマップ）だけに掛ける CSS フィルタ。例: 'brightness(0.6) saturate(0.7)'
   * deck.gl は別キャンバスなので軌跡の色はそのまま。地図を落ち着かせて軌跡を目立たせる用途。
   */
  mapFilter?: string
  /**
   * 利用者が自分で地図をドラッグ／ズームしたときに呼ばれる。
   * プログラムからの移動（setCenter など）では呼ばれない。
   * 追従モードを自動で解除するために使う。
   */
  onUserPan?: () => void
}

/** imperative helpers exposed via ref */
export interface MapCanvasHandle {
  flyTo(opts: {
    longitude: number
    latitude: number
    zoom?: number
    durationMs?: number
  }): void
  /**
   * bounds: [west, south, east, north]。maxZoom を渡すと、狭い範囲に寄りすぎないように止める。
   * padding は数値（四辺同じ）か、パネルや再生バーに隠れる辺だけ広げる四辺指定。
   */
  fitBounds(
    bounds: [number, number, number, number],
    padding?: number | { top: number; bottom: number; left: number; right: number },
    maxZoom?: number,
  ): void
  /**
   * ズームや向きを変えずに中心だけ移す。追従モードで毎フレーム呼ぶため、
   * アニメーションを挟まない（flyTo だと呼ぶたびに新しい動きが始まって震える）。
   */
  setCenter(longitude: number, latitude: number): void
  /** 地図の傾き（度）。3D の柱は真上から見ると高さが分からないため使う */
  setPitch(degrees: number, durationMs?: number): void
  getPitch(): number
  /**
   * いま見えている地図と軌跡を 1 枚の PNG にする。地図の帰属表示も焼き込む
   * （画像だけが共有されても ODbL / タイル配信元の表示が残るように）。
   */
  exportPng(): Promise<Blob | null>
  /** 録画を始める。label は動画の左上に焼き込む時刻の文字列を返す関数。録れない環境では null */
  startRecording(label: () => string): Recording | null
}

const DEFAULT_VIEW: Required<Pick<MapCanvasInitialViewState, 'longitude' | 'latitude' | 'zoom'>> = {
  longitude: 137.5,
  latitude: 37.0,
  zoom: 4.5,
}

/**
 * Adds (or replaces) the attribution control to match the active basemap.
 * CARTO basemaps must show ATTRIBUTION; 'none' shows no attribution control
 * at all (and, being sourceless, issues no network requests either).
 */
function syncAttribution(
  map: MapLibreMap,
  basemap: BasemapId,
  attributionRef: { current: AttributionControl | null },
): void {
  if (attributionRef.current) {
    map.removeControl(attributionRef.current)
    attributionRef.current = null
  }
  const attribution = attributionOf(basemap)
  if (attribution) {
    const control = new AttributionControl({
      compact: false,
      customAttribution: attribution,
    })
    map.addControl(control)
    attributionRef.current = control
  }
}

/**
 * setStyle のたびに層は入れ替わる（style.load ごとに呼ぶ想定）ので毎回付け直す。
 * buildBuildingsLayer はベクタ基図が無ければ null を返すので、ラスタ／オフライン基図では
 * 何もしない。ラベルの上に建物が被らないよう、最初の symbol レイヤの手前に挿す。
 */
function add3dBuildings(map: MapLibreMap): void {
  if (map.getLayer('buildings')) return
  const layer = buildBuildingsLayer(map.getStyle())
  if (!layer) return
  const labelLayerId = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id
  map.addLayer(layer, labelLayerId)
}

/**
 * 地図と deck.gl の 2 枚のキャンバスを合成して PNG にする。
 *
 * どちらも WebGL で preserveDrawingBuffer を切ってあるので、描画が終わって画面に
 * 出た後のバッファは読めない（真っ黒・透明になる）。同じタスクの中で両方を
 * 同期的に描き直し、その直後に drawImage すれば、合成前のバッファがまだ残っている。
 * 常時 preserveDrawingBuffer を有効にするより、再生中の描画が軽く済む。
 */
function composePng(
  map: MapLibreMap,
  overlay: MapboxOverlay | null,
  mapFilter: string | undefined,
  basemap: BasemapId,
): Promise<Blob | null> {
  // MapboxOverlay は内部の Deck を公開していない。非公開フィールドなので、
  // 取れなければ地図だけを書き出す（軌跡は欠けるが壊れはしない）。
  const deck = (overlay as unknown as { _deck?: Deck } | null)?._deck

  map.redraw()
  deck?.redraw('export-png')

  const mapCanvas = map.getCanvas()
  const deckCanvas = deck?.getCanvas() ?? null
  const out = document.createElement('canvas')
  out.width = mapCanvas.width
  out.height = mapCanvas.height
  const ctx = out.getContext('2d')
  if (!ctx) return Promise.resolve(null)

  ctx.fillStyle = '#0b0d12'
  ctx.fillRect(0, 0, out.width, out.height)
  // 「地図を沈める」は CSS の filter で掛けているので、画像にも同じものを掛ける
  if (mapFilter) ctx.filter = mapFilter
  ctx.drawImage(mapCanvas, 0, 0)
  ctx.filter = 'none'
  if (deckCanvas) ctx.drawImage(deckCanvas, 0, 0, out.width, out.height)

  const attribution = attributionOf(basemap)
  const scale = out.width / Math.max(1, mapCanvas.clientWidth)
  const text = attribution ? `${attribution} · MyGravityMap` : 'MyGravityMap'
  ctx.font = `${Math.round(11 * scale)}px system-ui, sans-serif`
  const pad = Math.round(6 * scale)
  const w = ctx.measureText(text).width + pad * 2
  const h = Math.round(18 * scale)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.fillRect(out.width - w, out.height - h, w, h)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, out.width - w + pad, out.height - h / 2)

  return new Promise((resolve) => out.toBlob(resolve, 'image/png'))
}

export const MapCanvas = forwardRef<MapCanvasHandle, MapCanvasProps>(
  function MapCanvas(props, ref) {
    const {
      layers,
      basemap = 'dark',
      initialViewState,
      onViewStateChange,
      children,
      mapFilter,
      onUserPan,
      onAvailabilityChange,
    } = props

    const [status, setStatus] = useState<MapStatus>({ phase: 'loading' })
    const [attempt, setAttempt] = useState(0)
    const sessionRef = useRef<MapSession | null>(null)
    const availabilityRef = useRef(onAvailabilityChange)
    availabilityRef.current = onAvailabilityChange

    const containerRef = useRef<HTMLDivElement | null>(null)
    const mapRef = useRef<MapLibreMap | null>(null)
    const overlayRef = useRef<MapboxOverlay | null>(null)
    const attributionRef = useRef<AttributionControl | null>(null)
    /** basemap id that the live map instance currently renders */
    const appliedBasemapRef = useRef<BasemapId | null>(null)

    // Latest-value refs so the mount effect (empty deps) and the moveend
    // handler always see current props without needing to be re-registered.
    const layersRef = useRef(layers)
    layersRef.current = layers
    const basemapRef = useRef(basemap)
    basemapRef.current = basemap
    const initialViewStateRef = useRef(initialViewState)
    const onViewStateChangeRef = useRef(onViewStateChange)
    onViewStateChangeRef.current = onViewStateChange
    const onUserPanRef = useRef(onUserPan)
    onUserPanRef.current = onUserPan
    const mapFilterRef = useRef(mapFilter)
    mapFilterRef.current = mapFilter

    useImperativeHandle(
      ref,
      () => ({
        flyTo({ longitude, latitude, zoom, durationMs }) {
          const map = mapRef.current
          if (!map) return
          // Build the options object incrementally: passing an explicit
          // `undefined` for zoom/duration is not the same as omitting the
          // key for maplibre's camera option handling, so only set keys
          // that were actually provided.
          const opts: FlyToOptions = { center: [longitude, latitude] }
          if (zoom !== undefined) opts.zoom = zoom
          if (durationMs !== undefined) opts.duration = durationMs
          sessionRef.current?.run(() => map.flyTo(opts))
        },
        fitBounds(bounds, padding, maxZoom) {
          const map = mapRef.current
          if (!map) return
          const opts: FitBoundsOptions = {}
          if (padding !== undefined) opts.padding = padding
          if (maxZoom !== undefined) opts.maxZoom = maxZoom
          sessionRef.current?.run(() => map.fitBounds(bounds, opts))
        },
        setCenter(longitude, latitude) {
          // jumpTo はアニメーションを伴わない。追従モードで毎フレーム呼ぶので、
          // flyTo/easeTo だと動きが積み重なって震える。
          sessionRef.current?.run(() => mapRef.current?.jumpTo({ center: [longitude, latitude] }))
        },
        setPitch(degrees, durationMs) {
          sessionRef.current?.run(() => mapRef.current?.easeTo({ pitch: degrees, duration: durationMs ?? 600 }))
        },
        getPitch() {
          return sessionRef.current?.run(() => mapRef.current?.getPitch()) ?? 0
        },
        exportPng() {
          const map = mapRef.current
          if (!map || !sessionRef.current?.ready) return Promise.resolve(null)
          return sessionRef.current?.run(() => composePng(map, overlayRef.current, mapFilterRef.current, basemapRef.current)) ?? Promise.resolve(null)
        },
        startRecording(label) {
          const map = mapRef.current
          if (!map || !sessionRef.current?.ready) return null
          return sessionRef.current?.run(() => startRecording(map, overlayRef.current, {
            mapFilter: mapFilterRef.current,
            attribution: attributionOf(basemapRef.current),
            label,
          })) ?? null
        },
      }),
      [],
    )

    // Create map + deck.gl once per attempt. Cleanup fully tears
    // down the map so this survives React 19 StrictMode's dev-mode
    // mount -> cleanup -> mount without leaking a map instance or throwing.
    useEffect(() => {
      const container = containerRef.current
      if (!container) return

      const initial = initialViewStateRef.current
      const startBasemap = basemapRef.current

      // Only set pitch/bearing when actually provided -- an explicit
      // `undefined` is not the same as an omitted key for maplibre's
      // camera option handling (same reasoning as flyTo/fitBounds below).
      const mapOptions: MapOptions = {
        container,
        style: BASEMAPS[startBasemap].style,
        center: [initial?.longitude ?? DEFAULT_VIEW.longitude, initial?.latitude ?? DEFAULT_VIEW.latitude],
        zoom: initial?.zoom ?? DEFAULT_VIEW.zoom,
        // We manage attribution ourselves so it stays in sync with `basemap`.
        attributionControl: false,
      }
      if (initial?.pitch !== undefined) mapOptions.pitch = initial.pitch
      if (initial?.bearing !== undefined) mapOptions.bearing = initial.bearing

      const session = mountMap({
        supported: supportsWebGL2,
        createMap: () => {
          ensureMaplibreWorker()
          // Each attempt owns a disposable host, so even a partial constructor's
          // DOM listeners cannot remain attached to the reusable React container.
          const surface = document.createElement('div')
          Object.assign(surface.style, { position: 'absolute', inset: '0' })
          container.append(surface)
          return new MapLibreMap({ ...mapOptions, container: surface })
        },
        createNavigation: () => new NavigationControl(),
        createScale: () => new ScaleControl(),
        createOverlay: (onError) => new MapboxOverlay({ interleaved: false, layers: layersRef.current, onError }),
        onStatus: (next) => {
          setStatus(next)
          availabilityRef.current?.(next.phase === 'ready')
        },
        onMap: (map) => {
          mapRef.current = map
          appliedBasemapRef.current = map ? startBasemap : null
          if (!map) attributionRef.current = null
          if (import.meta.env.DEV) {
            const debug = window as unknown as { __map?: MapLibreMap }
            if (map) debug.__map = map
            else delete debug.__map
          }
        },
        onOverlay: (overlay) => { overlayRef.current = overlay },
        clearContainer: () => {
          container.replaceChildren()
          container.classList.remove('maplibregl-map')
        },
        syncAttribution: (map) => syncAttribution(map, startBasemap, attributionRef),
        addBuildings: add3dBuildings,
        onMove: (map) => {
          const center = map.getCenter()
          onViewStateChangeRef.current?.({ longitude: center.lng, latitude: center.lat, zoom: map.getZoom() })
        },
        onUserPan: () => onUserPanRef.current?.(),
      })
      sessionRef.current = session
      return () => {
        session.dispose()
        if (sessionRef.current === session) sessionRef.current = null
      }
      // Retry recreates rendering resources only. Latest app data stays in refs/store.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [attempt])

    // Push new deck.gl layers into the existing overlay without recreating
    // the map or the overlay.
    useEffect(() => {
      sessionRef.current?.run(() => overlayRef.current?.setProps({ layers }))
    }, [layers])

    // Swap the maplibre style in place when `basemap` changes; never
    // recreate the map itself.
    useEffect(() => {
      const map = mapRef.current
      if (!map) return
      if (appliedBasemapRef.current === basemap) return

      sessionRef.current?.run(() => {
        map.setStyle(BASEMAPS[basemap].style)
        syncAttribution(map, basemap, attributionRef)
        appliedBasemapRef.current = basemap
      })
    }, [basemap])

    return (
      <div className="mgm-map-canvas">
        <div
          ref={containerRef}
          className="mgm-map-canvas__map"
          style={mapFilter ? ({ '--map-filter': mapFilter } as React.CSSProperties) : undefined}
        />
        <div className="mgm-map-canvas__overlay" hidden={status.phase !== 'ready'}>{children}</div>
        <MapStatusNotice status={status} onRetry={() => setAttempt((value) => value + 1)} />
      </div>
    )
  },
)
