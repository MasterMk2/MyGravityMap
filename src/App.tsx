import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Layer } from '@deck.gl/core'
import { MapCanvas, type MapCanvasHandle } from './map/MapCanvas'
import type { BasemapId } from './map/basemaps'
import { useAppStore } from './store/useAppStore'
import { usePlayback } from './playback/usePlayback'
import { buildPlaybackLayers } from './playback/layers'
import { buildGravityLayers, DEFAULT_GRAVITY, type GravitySettings } from './gravity/layers'
import { buildWeightedPoints } from './gravity/weights'
import { FileDrop } from './ui/FileDrop'
import { StatsPanel } from './ui/StatsPanel'
import { PlaybackBar } from './ui/PlaybackBar'
import './App.css'

export function App() {
  const { status, dataset } = useAppStore()
  const [basemap, setBasemap] = useState<BasemapId>('dark')
  /** 地図を沈める量。軌跡を浮かせるための既定値 */
  const [dim, setDim] = useState(0.35)
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
  }, [status, dataset])

  // 明るさと彩度を同時に落とす。deck.gl は別キャンバスなので軌跡の色は変わらない。
  const mapFilter =
    dim > 0 ? `brightness(${(1 - dim * 0.75).toFixed(2)}) saturate(${(1 - dim * 0.6).toFixed(2)})` : ''

  // 開発時だけ: ?dev=/Sampledata/location-history.json でファイル選択を省略できる。
  // dev サーバはリポジトリ内のファイルを配信するので、手作業なしに実データで確認できる。
  // 本番ビルドでは import.meta.env.DEV が false なので到達しない。
  const devUrlLoaded = useRef(false)
  useEffect(() => {
    if (!import.meta.env.DEV || devUrlLoaded.current) return
    const dev = new URLSearchParams(window.location.search).get('dev')
    if (!dev) return
    devUrlLoaded.current = true
    void useAppStore.getState().loadDevUrl(dev)
  }, [])

  const pb = usePlayback(dataset)

  const [gravity, setGravity] = useState<GravitySettings>(DEFAULT_GRAVITY)

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

  const gravityPoints = useMemo(
    () => buildWeightedPoints(dataset, pb.trips, pb.selection, gravity.source),
    [dataset, pb.trips, pb.selection, gravity.source],
  )

  // 選択中の期間に Google の訪問データがあるか（2024 年秋以降のみ存在する）
  const visitAvailable = useMemo(
    () =>
      (dataset?.visits ?? []).some(
        (v) => v.start < pb.selection.end && v.end > pb.selection.start,
      ),
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

  // 重力マップを先に積む＝軌跡がその上に描かれる
  const layers = useMemo<Layer[]>(
    () => [...gravityLayers, ...playbackLayers],
    [gravityLayers, playbackLayers],
  )

  return (
    <div className="app" style={{ ['--dock-h' as string]: `${dockHeight}px` } as React.CSSProperties}>
      <MapCanvas
        ref={mapRef}
        layers={layers}
        basemap={basemap}
        mapFilter={mapFilter}
        onViewStateChange={onViewStateChange}
        // 自分で地図を動かしたら追従を解除する（引っ張り合いにならないように）
        onUserPan={() => {
          if (pb.settings.camera === 'follow') pb.changeSettings({ camera: 'fixed' })
        }}
      >
        {status !== 'ready' && <FileDrop />}
        {status === 'ready' && dataset && (
          <StatsPanel
            dataset={dataset}
            basemap={basemap}
            onBasemapChange={setBasemap}
            dim={dim}
            onDimChange={setDim}
            onFocus={(lon, lat) => mapRef.current?.flyTo({ longitude: lon, latitude: lat, zoom: 12 })}
            gravity={gravity}
            onGravityChange={changeGravity}
            gravityPoints={gravityPoints}
            visitAvailable={visitAvailable}
          />
        )}
        {status === 'ready' && dataset && (
          <div className="dock-bottom" ref={dockRef}>
            <PlaybackBar
              bounds={pb.bounds}
              window={pb.selection}
              onWindowChange={pb.changeWindow}
              playing={pb.playing}
              onPlayingChange={pb.setPlaying}
              currentTime={pb.currentTime}
              onScrub={pb.scrub}
              progress={pb.progress}
              settings={pb.settings}
              onSettingsChange={pb.changeSettings}
              coverage={dataset.coverage}
              tzOffsetMin={pb.tzOffsetMin}
            />
          </div>
        )}
      </MapCanvas>
    </div>
  )
}
