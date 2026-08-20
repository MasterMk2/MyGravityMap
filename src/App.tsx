import { useEffect, useMemo, useRef, useState } from 'react'
import type { Layer } from '@deck.gl/core'
import { MapCanvas, type MapCanvasHandle } from './map/MapCanvas'
import type { BasemapId } from './map/basemaps'
import { useAppStore } from './store/useAppStore'
import { usePlayback } from './playback/usePlayback'
import { buildPlaybackLayers } from './playback/layers'
import { FileDrop } from './ui/FileDrop'
import { StatsPanel } from './ui/StatsPanel'
import { PlaybackBar } from './ui/PlaybackBar'
import './App.css'

export function App() {
  const { status, dataset } = useAppStore()
  const [basemap, setBasemap] = useState<BasemapId>('dark')
  const mapRef = useRef<MapCanvasHandle>(null)

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

  const layers = useMemo<Layer[]>(() => {
    if (!dataset) return []
    return buildPlaybackLayers({
      trips: pb.trips,
      rel: pb.rel,
      currentRel: pb.currentRel,
      settings: pb.settings,
      colors: pb.colors,
      activeVisit: pb.activeVisit,
    })
  }, [dataset, pb.trips, pb.rel, pb.currentRel, pb.settings, pb.colors, pb.activeVisit])

  return (
    <div className="app">
      <MapCanvas ref={mapRef} layers={layers} basemap={basemap}>
        {status !== 'ready' && <FileDrop />}
        {status === 'ready' && dataset && (
          <StatsPanel
            dataset={dataset}
            basemap={basemap}
            onBasemapChange={setBasemap}
            onFocus={(lon, lat) => mapRef.current?.flyTo({ longitude: lon, latitude: lat, zoom: 12 })}
          />
        )}
        {status === 'ready' && dataset && (
          <div className="dock-bottom">
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
