import { useEffect, useMemo, useRef, useState } from 'react'
import { PathLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import { MapCanvas, type MapCanvasHandle } from './map/MapCanvas'
import type { BasemapId } from './map/basemaps'
import { useAppStore } from './store/useAppStore'
import type { Trip } from './core/types'
import { FileDrop } from './ui/FileDrop'
import { StatsPanel } from './ui/StatsPanel'
import './App.css'

/** 年ごとに色を変える（8 年分の層が見えるように） */
function yearColor(year: number, tMinYear: number, tMaxYear: number): [number, number, number] {
  const span = Math.max(1, tMaxYear - tMinYear)
  const h = ((year - tMinYear) / span) * 280 // 青 → 赤紫
  const s = 0.75
  const l = 0.58
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

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

  const layers = useMemo<Layer[]>(() => {
    if (!dataset) return []
    const years = dataset.coverage.map((c) => c.year)
    const minYear = years.length ? Math.min(...years) : 2018
    const maxYear = years.length ? Math.max(...years) : 2026
    // 1 点しかないトリップは線にならないので除外する（後で点として描く）
    const drawable = dataset.trips.filter((t) => t.times.length >= 2)
    return [
      new PathLayer<Trip>({
        id: 'trips',
        data: drawable,
        positionFormat: 'XY',
        getPath: (t: Trip) => t.coords as unknown as number[],
        getColor: (t: Trip) => {
          const year = new Date(t.tStart * 1000).getUTCFullYear()
          return yearColor(year, minYear, maxYear)
        },
        getWidth: 2,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        capRounded: true,
        jointRounded: true,
        opacity: 0.55,
        pickable: false,
      }),
    ]
  }, [dataset])

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
      </MapCanvas>
    </div>
  )
}
