import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Layer } from '@deck.gl/core'
import { MapCanvas, type MapCanvasHandle } from './map/MapCanvas'
import { BASEMAPS, type BasemapId } from './map/basemaps'
import { useAppStore } from './store/useAppStore'
import { usePlayback } from './playback/usePlayback'
import { buildPlaybackLayers } from './playback/layers'
import {
  buildGravityLayers,
  DEFAULT_GRAVITY,
  isGravitySettings,
  type GravitySettings,
} from './gravity/layers'
import { buildWeightedPoints, hasVisitWeights } from './gravity/weights'
import { FileDrop } from './ui/FileDrop'
import { StatsPanel } from './ui/StatsPanel'
import { formatClock, isNarrowScreen, PlaybackBar } from './ui/PlaybackBar'
import { canRecord, type Recording } from './map/recorder'
import { usePersistentState } from './store/usePersistentState'
import type { Trip } from './core/types'
import { localDayKey } from './core/geo'
import { localDayRange } from './core/timezone'
import { yearlyBarycenters, type YearBarycenter } from './core/barycenter'
import { buildBarycenterLayers, coverageYearRange } from './views/barycenterLayers'
import { downloadBlob } from './ui/download'
import './App.css'

const isBasemap = (v: unknown): v is BasemapId => typeof v === 'string' && v in BASEMAPS
const isDim = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 0.85

/** [start, end) に記録された軌跡の点の範囲 [west, south, east, north]。点が無ければ null */
function boundsOfDay(trips: Trip[], start: number, end: number): [number, number, number, number] | null {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const t of trips) {
    if (t.tEnd < start || t.tStart >= end) continue
    for (let i = 0; i < t.times.length; i++) {
      const time = t.times[i]!
      if (time < start || time >= end) continue
      const lon = t.coords[i * 2]!
      const lat = t.coords[i * 2 + 1]!
      if (lon < w) w = lon
      if (lon > e) e = lon
      if (lat < s) s = lat
      if (lat > n) n = lat
    }
  }
  return Number.isFinite(w) ? [w, s, e, n] : null
}

export function App() {
  const { status, dataset } = useAppStore()
  const [mapAvailable, setMapAvailable] = useState(false)
  // 見た目の設定は端末に保存して、次に開いたときも同じにする
  const [basemap, setBasemap] = usePersistentState<BasemapId>('basemap', 'dark', isBasemap)
  /** 地図を沈める量。軌跡を浮かせるための既定値 */
  const [dim, setDim] = usePersistentState('dim', 0.35, isDim)
  // UI の格納。地図だけを大きく見たいときのため。h キーで両方まとめて切り替える。
  // 電話の幅ではパネルを畳んだ状態から始める（開いていると地図がほとんど見えない）
  const [showPanel, setShowPanel] = useState(() => !isNarrowScreen())
  const [showBar, setShowBar] = useState(true)
  const mapRef = useRef<MapCanvasHandle>(null)

  // 下の再生バーの高さを測って CSS 変数に流す。
  // バーは中身に応じて折り返して高さが変わるので、決め打ちの余白だと
  // 左パネルが潜り込んだり無駄に短くなったりする。
  const dockRef = useRef<HTMLDivElement>(null)
  const [dockHeight, setDockHeight] = useState(0)
  useEffect(() => {
    const el = dockRef.current
    if (!el) {
      setDockHeight(0)
      return
    }
    // ResizeObserver は環境によって初回が来ないことがあるので、まず一度測る
    setDockHeight(el.getBoundingClientRect().height)
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height
      if (h !== undefined) setDockHeight(h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [status, dataset, showBar])

  // 明るさと彩度を同時に落とす。deck.gl は別キャンバスなので軌跡の色は変わらない。
  const mapFilter =
    dim > 0 ? `brightness(${(1 - dim * 0.75).toFixed(2)}) saturate(${(1 - dim * 0.6).toFixed(2)})` : ''

  // URL で読み込むものを指定できる。
  // - ?demo: デモデータ（本番でも有効）
  // - ?dev=/Sampledata/location-history.json: 開発時だけ。dev サーバはリポジトリ内のファイルを
  //   配信するので、手作業なしに実データで確認できる。本番ビルドでは import.meta.env.DEV が false。
  const devUrlLoaded = useRef(false)
  useEffect(() => {
    if (devUrlLoaded.current) return
    const params = new URLSearchParams(window.location.search)
    // ?demo はデモデータを直接開く。公開版でもそのまま試せるリンクとして配れるように本番でも有効
    if (params.has('demo')) {
      devUrlLoaded.current = true
      void useAppStore.getState().loadDemo()
      return
    }
    if (!import.meta.env.DEV) return
    const dev = params.get('dev')
    if (!dev) return
    devUrlLoaded.current = true
    void useAppStore.getState().loadDevUrl(dev)
  }, [])

  const pb = usePlayback(dataset)

  /*
   * キーボード操作。h: UI をまとめて畳む / Space: 再生・一時停止 / ← →: 1 日（Shift で 1 週間）。
   * 入力欄・ボタン・スライダーにフォーカスがあるときは奪わない
   * （Space はボタンを押す、矢印はスライダーを動かす、が本来の動きなので）。
   */
  const { playing, setPlaying, stepDays } = pb
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!mapAvailable) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // window や document に直接届いたイベントでは target が要素ではない
      const el = e.target instanceof HTMLElement ? e.target : null
      const tag = el?.tagName
      if (el && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable)) return
      if (e.key === 'h' || e.key === 'H') {
        const hide = showPanel || showBar
        setShowPanel(!hide)
        setShowBar(!hide)
        return
      }
      if (useAppStore.getState().status !== 'ready' || tag === 'BUTTON') return
      // 地図にフォーカスがあるときの矢印は地図のスクロール（MapLibre の標準操作）に譲る
      if (el?.closest('.maplibregl-map') && e.key.startsWith('Arrow')) return
      if (e.key === ' ') {
        e.preventDefault()
        setPlaying(!playing)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        stepDays((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 7 : 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showPanel, showBar, playing, setPlaying, stepDays, mapAvailable])

  const [gravity, setGravity] = usePersistentState<GravitySettings>(
    'gravity',
    DEFAULT_GRAVITY,
    isGravitySettings,
  )

  /*
   * ヒートマップの格子はズームに追随させる（引きで明るくなりすぎないように）。
   * ただし地図を動かすたびに集計し直すと重いので、ズームは 0.5 刻み、
   * 緯度は 5 度刻みに丸めて、変わったときだけ状態を更新する。
   */
  const [view, setView] = useState({ zoom: 4.5, latitude: 37 })
  const onViewStateChange = useCallback((v: { zoom: number; latitude: number }) => {
    const zoom = Math.round(v.zoom * 2) / 2
    const latitude = Math.round(v.latitude / 5) * 5
    setView((prev) => (prev.zoom === zoom && prev.latitude === latitude ? prev : { zoom, latitude }))
  }, [])
  const changeGravity = (patch: Partial<GravitySettings>) =>
    setGravity((g) => ({ ...g, ...patch }))

  // 日数モードはマスごとに日を数えるので粒度が変わると数え直す。他のモードでは粒度に依存しない
  const dayCellMeters = gravity.radiusMeters
  const gravityPoints = useMemo(
    () => buildWeightedPoints(dataset, pb.trips, pb.selection, gravity.source, dayCellMeters, gravity.normalization ?? 'raw'),
    [dataset, pb.trips, pb.selection, gravity.source, dayCellMeters, gravity.normalization],
  )

  // 選択中の期間を「滞在」ソースで描けるか（Google の訪問データは 2024 年秋以降のみ）。
  // 軌跡から復元した滞在は滞在時間を信用できず重力マップには載らないので、
  // 判定は必ず weights.ts 側の条件を使う（数えたのに空、が起きないように）。
  const visitAvailable = useMemo(
    () => hasVisitWeights(dataset?.visits ?? [], pb.selection),
    [dataset, pb.selection],
  )

  // 3D の柱は真上から見ると高さが分からないので、六角柱を出したら地図を傾ける。
  // 既に傾けてある場合は触らない（利用者の視点を奪わないため）。
  const hexOn = gravity.mode === 'hex' || gravity.mode === 'both'
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (hexOn && map.getPitch() < 5) map.setPitch(50)
  }, [hexOn])

  // 追従モード: 現在地を画面の中央に捉え続ける。
  // jumpTo なのでアニメーションが積み重ならず、毎フレーム呼んでも震えない。
  const follow = pb.settings.camera === 'follow'
  const cursorLon = pb.cursor?.lon
  const cursorLat = pb.cursor?.lat
  useEffect(() => {
    if (!follow || cursorLon === undefined || cursorLat === undefined) return
    mapRef.current?.setCenter(cursorLon, cursorLat)
  }, [follow, cursorLon, cursorLat])

  /**
   * 地図を範囲に合わせるときの余白。左のパネルと下の再生バーに隠れる分だけ広げる
   * （四辺同じ余白だと、合わせた範囲の半分がパネルの下に入ってしまう）。
   */
  const fitPadding = useCallback(() => {
    const panel = document.querySelector('.panel')?.getBoundingClientRect()
    // 狭い画面では余白が地図より大きくなり、MapLibre が合わせるのを諦めてしまうので頭打ちにする
    return {
      top: 40,
      right: 60,
      left: Math.min((panel ? panel.right : 0) + 30, window.innerWidth * 0.5),
      bottom: Math.min(dockHeight + 40, window.innerHeight * 0.5),
    }
  }, [dockHeight])

  /*
   * 日ごとモード: 記録側の暦日が変わったら、その日の軌跡がちょうど収まるように合わせる。
   * 毎フレームではなく日が変わったときだけ動かす（fitBounds はアニメーションするので、
   * 連打すると画面が落ち着かない）。
   */
  const fitDay = pb.settings.camera === 'fitDay'
  const dayKey = dataset ? localDayKey(pb.currentTime, pb.tzOffsetMin) : ''
  const dayTrips = pb.trips
  const dayTz = pb.tzOffsetMin
  useEffect(() => {
    if (!fitDay || !dayKey) return
    const [start, end] = localDayRange(dayKey, dayTz)
    const bbox = boundsOfDay(dayTrips, start, end)
    if (bbox) mapRef.current?.fitBounds(bbox, fitPadding(), 14)
  }, [fitDay, dayKey, dayTrips, dayTz, fitPadding])

  // 重力マップは再生位置に依存しない。再生中は currentRel が毎フレーム変わるので、
  // 一緒の useMemo に入れると集計レイヤーを毎フレーム作り直すことになり、
  // 集計が終わる前に作り直されて柱が出たり出なかったりする。
  const gravityLayers = useMemo<Layer[]>(
    () =>
      dataset
        ? buildGravityLayers({
            mode: gravity.mode,
            points: gravityPoints,
            radiusMeters: gravity.radiusMeters,
            intensity: gravity.intensity,
            contrast: gravity.contrast,
            opacity: gravity.opacity,
            zoom: view.zoom,
            latitude: view.latitude,
          })
        : [],
    [dataset, gravity, gravityPoints, view],
  )

  const playbackLayers = useMemo<Layer[]>(
    () =>
      dataset
        ? buildPlaybackLayers({
            trips: pb.trips,
            rel: pb.rel,
            currentRel: pb.currentRel,
            settings: pb.settings,
            colors: pb.colors,
            activeVisit: pb.activeVisit,
            cursor: pb.cursor,
          })
        : [],
    [dataset, pb.trips, pb.rel, pb.currentRel, pb.settings, pb.colors, pb.activeVisit, pb.cursor],
  )

  // 年ごとの重心。地図に出すときだけ数える（全軌跡を 1 周するので、見ないなら払わない）。
  // 表（重心タブ）と地図が同じ計算結果を見るよう、数えたものはパネルにも渡す。
  const [showBarycenter, setShowBarycenter] = useState(false)
  const [barycenterYear, setBarycenterYear] = useState<number | null>(null)
  const barycenters = useMemo<YearBarycenter[] | undefined>(
    () => (dataset && showBarycenter ? yearlyBarycenters(dataset) : undefined),
    [dataset, showBarycenter],
  )
  const barycenterLayers = useMemo<Layer[]>(() => {
    if (!dataset || !barycenters) return []
    return buildBarycenterLayers(barycenters, {
      ...coverageYearRange(dataset),
      selectedYear: barycenterYear,
    })
  }, [dataset, barycenters, barycenterYear])

  // 重力マップ → 重心 → 軌跡の順に積む（後ろほど上に描かれる）
  const layers = useMemo<Layer[]>(
    () => [...gravityLayers, ...barycenterLayers, ...playbackLayers],
    [gravityLayers, barycenterLayers, playbackLayers],
  )

  /*
   * 録画。「録画しながら再生」を押すと再生を始め、再生が止まったら（一時停止・末尾・■）保存する。
   * 何を録ったかの区切りが「1 回の再生」と一致するので分かりやすい。
   */
  const recordingRef = useRef<Recording | null>(null)
  const [recording, setRecording] = useState(false)
  const clockRef = useRef('')
  clockRef.current = formatClock(pb.currentTime, pb.tzOffsetMin)
  const stopRecording = useCallback(async (save = true) => {
    const rec = recordingRef.current
    if (!rec) return
    recordingRef.current = null
    setRecording(false)
    const blob = await rec.stop()
    if (blob && save) downloadBlob(`mygravitymap-${Date.now().toString(36)}.${rec.extension}`, blob)
  }, [])
  const toggleRecording = useCallback(() => {
    if (recordingRef.current) {
      setPlaying(false)
      void stopRecording()
      return
    }
    const rec = mapRef.current?.startRecording(() => clockRef.current)
    if (!rec) return
    recordingRef.current = rec
    setRecording(true)
    setPlaying(true)
  }, [setPlaying, stopRecording])
  useEffect(() => {
    if (recording && !playing) void stopRecording()
  }, [recording, playing, stopRecording])
  const recordSupported = useMemo(() => canRecord(), [])

  const exportPng = useCallback(async () => {
    const blob = await mapRef.current?.exportPng()
    if (!blob) return
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    downloadBlob(`mygravitymap-${stamp}.png`, blob)
  }, [])

  return (
    <div className="app" style={{ ['--dock-h' as string]: `${dockHeight}px` } as React.CSSProperties}>
      <MapCanvas
        ref={mapRef}
        layers={layers}
        onAvailabilityChange={(available) => {
          setMapAvailable(available)
          if (!available) {
            setPlaying(false)
            // A failed render must not silently export a recording as successful.
            void stopRecording(false)
          }
        }}
        basemap={basemap}
        mapFilter={mapFilter}
        onViewStateChange={onViewStateChange}
        // 自分で地図を動かしたら追従を解除する（引っ張り合いにならないように）
        onUserPan={() => {
          if (pb.settings.camera !== 'fixed') pb.changeSettings({ camera: 'fixed' })
        }}
      >
        {status !== 'ready' && <FileDrop />}
        {status === 'ready' && dataset && !showPanel && (
          <button
            className="ui-reveal ui-reveal--left"
            onClick={() => setShowPanel(true)}
            title="情報パネルを開く（h キーでまとめて切り替え）"
          >
            ☰
          </button>
        )}
        {status === 'ready' && dataset && showPanel && (
          <StatsPanel
            onCollapse={() => setShowPanel(false)}
            dataset={dataset}
            selection={pb.selection}
            onSelectWindow={pb.changeWindow}
            basemap={basemap}
            onBasemapChange={setBasemap}
            dim={dim}
            onDimChange={setDim}
            onFocus={(lon, lat, zoom) =>
              mapRef.current?.flyTo({ longitude: lon, latitude: lat, zoom: zoom ?? 12 })
            }
            onFitBounds={(bbox) => mapRef.current?.fitBounds(bbox, fitPadding())}
            gravity={gravity}
            onGravityChange={changeGravity}
            gravityPoints={gravityPoints}
            visitAvailable={visitAvailable}
            showBarycenter={showBarycenter}
            onShowBarycenterChange={setShowBarycenter}
            barycenters={barycenters}
            barycenterYear={barycenterYear}
            onBarycenterYearChange={setBarycenterYear}
            onExportPng={exportPng}
          />
        )}
        {status === 'ready' && dataset && !showBar && (
          <button
            className="ui-reveal ui-reveal--bottom"
            onClick={() => setShowBar(true)}
            title="再生バーを開く（h キーでまとめて切り替え）"
          >
            ▲ 再生
          </button>
        )}
        {status === 'ready' && dataset && showBar && (
          <div className="dock-bottom" ref={dockRef}>
            <button
              className="dock-bottom__collapse"
              onClick={() => setShowBar(false)}
              title="再生バーを閉じる"
              aria-label="再生バーを閉じる"
            >
              ▼
            </button>
            <PlaybackBar
              bounds={pb.bounds}
              window={pb.selection}
              onWindowChange={pb.changeWindow}
              playing={pb.playing}
              onPlayingChange={pb.setPlaying}
              currentTime={pb.currentTime}
              onScrub={pb.scrub}
              onStepDays={pb.stepDays}
              recording={recording}
              onRecordToggle={recordSupported ? toggleRecording : undefined}
              progress={pb.progress}
              settings={pb.settings}
              onSettingsChange={pb.changeSettings}
              onPaceChange={pb.changePace}
              coverage={dataset.coverage}
              tzOffsetMin={pb.tzOffsetMin}
            />
          </div>
        )}
      </MapCanvas>
    </div>
  )
}
