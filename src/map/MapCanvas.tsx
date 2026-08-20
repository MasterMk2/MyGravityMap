import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
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
import type { Layer } from '@deck.gl/core'
import { BASEMAPS, attributionOf } from './basemaps'
import type { BasemapId } from './basemaps'
import { ensureMaplibreWorker } from './maplibreWorker'
import './MapCanvas.css'

// 地図を作る前に Worker の場所を教えておく（詳細は maplibreWorker.ts）
ensureMaplibreWorker()

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
  /** bounds: [west, south, east, north] */
  fitBounds(bounds: [number, number, number, number], padPx?: number): void
  /**
   * ズームや向きを変えずに中心だけ移す。追従モードで毎フレーム呼ぶため、
   * アニメーションを挟まない（flyTo だと呼ぶたびに新しい動きが始まって震える）。
   */
  setCenter(longitude: number, latitude: number): void
  /** 地図の傾き（度）。3D の柱は真上から見ると高さが分からないため使う */
  setPitch(degrees: number, durationMs?: number): void
  getPitch(): number
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
    } = props

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
          map.flyTo(opts)
        },
        fitBounds(bounds, padPx) {
          const map = mapRef.current
          if (!map) return
          const opts: FitBoundsOptions = {}
          if (padPx !== undefined) opts.padding = padPx
          map.fitBounds(bounds, opts)
        },
        setCenter(longitude, latitude) {
          // jumpTo はアニメーションを伴わない。追従モードで毎フレーム呼ぶので、
          // flyTo/easeTo だと動きが積み重なって震える。
          mapRef.current?.jumpTo({ center: [longitude, latitude] })
        },
        setPitch(degrees, durationMs) {
          mapRef.current?.easeTo({ pitch: degrees, duration: durationMs ?? 600 })
        },
        getPitch() {
          return mapRef.current?.getPitch() ?? 0
        },
      }),
      [],
    )

    // Create the map + deck.gl overlay exactly once. Cleanup fully tears
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

      const map = new MapLibreMap(mapOptions)
      mapRef.current = map
      // 開発時のみ: コンソールから地図の状態を確認できるようにする
      if (import.meta.env.DEV) {
        ;(window as unknown as { __map: MapLibreMap }).__map = map
        map.on('error', (e) => {
          ;((window as unknown as { __mapErrs?: string[] }).__mapErrs ??= []).push(
            String((e as unknown as { error?: Error }).error?.message ?? e),
          )
        })
      }
      appliedBasemapRef.current = startBasemap

      map.addControl(new NavigationControl(), 'top-right')
      map.addControl(new ScaleControl(), 'bottom-left')

      const overlay = new MapboxOverlay({
        interleaved: false,
        layers: layersRef.current,
      })
      overlayRef.current = overlay
      map.addControl(overlay)

      syncAttribution(map, startBasemap, attributionRef)

      // Defensive: some maplibre/deck.gl version combos have dropped a
      // control across setStyle. Re-add the deck.gl overlay if it's
      // missing once the new style has finished loading.
      const handleStyleLoad = () => {
        const currentOverlay = overlayRef.current
        if (currentOverlay && !map.hasControl(currentOverlay)) {
          map.addControl(currentOverlay)
        }
      }
      map.on('style.load', handleStyleLoad)

      const handleMove = () => {
        const center = map.getCenter()
        onViewStateChangeRef.current?.({
          longitude: center.lng,
          latitude: center.lat,
          zoom: map.getZoom(),
        })
      }
      map.on('move', handleMove)

      // originalEvent があるものだけが利用者操作。setCenter などのプログラム移動では付かない。
      const handleUserPan = (e: { originalEvent?: unknown }) => {
        if (e.originalEvent) onUserPanRef.current?.()
      }
      map.on('dragstart', handleUserPan)
      map.on('zoomstart', handleUserPan)

      return () => {
        map.off('style.load', handleStyleLoad)
        map.off('move', handleMove)
        map.off('dragstart', handleUserPan)
        map.off('zoomstart', handleUserPan)
        map.remove()
        mapRef.current = null
        overlayRef.current = null
        attributionRef.current = null
        appliedBasemapRef.current = null
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once; latest values are read via refs
    }, [])

    // Push new deck.gl layers into the existing overlay without recreating
    // the map or the overlay.
    useEffect(() => {
      overlayRef.current?.setProps({ layers })
    }, [layers])

    // Swap the maplibre style in place when `basemap` changes; never
    // recreate the map itself.
    useEffect(() => {
      const map = mapRef.current
      if (!map) return
      if (appliedBasemapRef.current === basemap) return

      map.setStyle(BASEMAPS[basemap].style)
      syncAttribution(map, basemap, attributionRef)
      appliedBasemapRef.current = basemap
    }, [basemap])

    return (
      <div className="mgm-map-canvas">
        <div
          ref={containerRef}
          className="mgm-map-canvas__map"
          style={mapFilter ? ({ '--map-filter': mapFilter } as React.CSSProperties) : undefined}
        />
        <div className="mgm-map-canvas__overlay">{children}</div>
      </div>
    )
  },
)
