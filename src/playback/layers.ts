import type { Layer } from '@deck.gl/core'
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers'
import { TripsLayer } from '@deck.gl/geo-layers'
import type { PlaybackSettings, Trip, Visit } from '../core/types'

export interface PlaybackLayerInput {
  /** 期間で絞り込んだトリップ（時刻の昇順） */
  trips: Trip[]
  /** trips と同じ順序の、期間開始からの相対秒（float32） */
  rel: Float32Array[]
  /** 現在の再生位置（期間開始からの相対秒） */
  currentRel: number
  settings: PlaybackSettings
  /** トリップごとの RGB（computeTripColors の出力） */
  colors: Uint8Array
  /** いま滞在中の訪問（あれば滞在円を出す） */
  activeVisit?: Visit | undefined
  /** 滞在円を出す上限速度。これより速い再生では出さない */
  stayCircleMaxSpeed?: number
}

function colorOf(colors: Uint8Array, i: number, alpha: number): [number, number, number, number] {
  return [colors[i * 3] ?? 255, colors[i * 3 + 1] ?? 255, colors[i * 3 + 2] ?? 255, alpha]
}

/**
 * 進行中のトリップを「現在時刻まで」で切り詰めた部分パスを作る。
 * 完了済みのトリップは切り詰め不要なのでそのまま使う（毎フレーム作り直さない）。
 */
function partialPath(trip: Trip, rel: Float32Array, currentRel: number): number[] | null {
  const n = rel.length
  if (n === 0) return null
  // rel は昇順。currentRel 以下の最後の添字を二分探索
  let lo = 0
  let hi = n - 1
  if (rel[0]! > currentRel) return null
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (rel[mid]! <= currentRel) lo = mid
    else hi = mid - 1
  }
  const count = lo + 1
  if (count < 2) return null
  const out = new Array<number>(count * 2)
  for (let i = 0; i < count * 2; i++) out[i] = trip.coords[i]!
  return out
}

export function buildPlaybackLayers(input: PlaybackLayerInput): Layer[] {
  const { trips, rel, currentRel, settings, colors, activeVisit } = input
  const layers: Layer[] = []
  const alpha = Math.round(Math.max(0, Math.min(1, settings.opacity)) * 255)
  const showGradient = settings.trail === 'gradient' || settings.trail === 'both'
  const showSolid = settings.trail === 'solid' || settings.trail === 'both'
  const parameters = settings.additiveBlending
    ? { blend: true, blendColorSrcFactor: 'src-alpha' as const, blendColorDstFactor: 'one' as const }
    : undefined

  if (showSolid) {
    // 完了済み: そのまま全体を描く。currentRel が進むと本数だけが増える。
    let doneCount = 0
    while (doneCount < trips.length && (rel[doneCount]?.[rel[doneCount]!.length - 1] ?? 0) <= currentRel) {
      doneCount++
    }
    const done = trips.slice(0, doneCount)

    layers.push(
      new PathLayer<Trip>({
        id: 'playback-solid-done',
        data: done,
        positionFormat: 'XY',
        getPath: (t) => t.coords as unknown as number[],
        getColor: (_t, { index }) => colorOf(colors, index, settings.trail === 'both' ? Math.round(alpha * 0.45) : alpha),
        getWidth: settings.lineWidth,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        capRounded: true,
        jointRounded: true,
        ...(parameters ? { parameters } : {}),
        updateTriggers: {
          getColor: [settings.colorBy, settings.trail, alpha, colors],
        },
      }),
    )

    // 進行中: 数本しかないので、毎フレーム切り詰めても軽い。
    const active: Array<{ path: number[]; index: number }> = []
    for (let i = doneCount; i < trips.length; i++) {
      const r = rel[i]!
      if (r[0]! > currentRel) break
      const path = partialPath(trips[i]!, r, currentRel)
      if (path) active.push({ path, index: i })
    }
    if (active.length > 0) {
      layers.push(
        new PathLayer<{ path: number[]; index: number }>({
          id: 'playback-solid-active',
          data: active,
          positionFormat: 'XY',
          getPath: (d) => d.path,
          getColor: (d) => colorOf(colors, d.index, alpha),
          getWidth: settings.lineWidth,
          widthUnits: 'pixels',
          widthMinPixels: 1,
          capRounded: true,
          jointRounded: true,
          ...(parameters ? { parameters } : {}),
          updateTriggers: { getPath: currentRel, getColor: [settings.colorBy, alpha, colors] },
        }),
      )
    }
  }

  if (showGradient) {
    layers.push(
      new TripsLayer<Trip>({
        id: 'playback-gradient',
        data: trips,
        positionFormat: 'XY',
        getPath: (t) => t.coords as unknown as number[],
        getTimestamps: (_t, { index }) => rel[index] as unknown as number[],
        getColor: (_t, { index }) => colorOf(colors, index, 255),
        currentTime: currentRel,
        trailLength: settings.trailLengthSec,
        fadeTrail: true,
        getWidth: settings.lineWidth + 1,
        widthUnits: 'pixels',
        widthMinPixels: 2,
        capRounded: true,
        jointRounded: true,
        opacity: settings.opacity,
        ...(parameters ? { parameters } : {}),
        updateTriggers: { getColor: [settings.colorBy, colors] },
      }),
    )
  }

  // 止まっている間は点が動かないので、滞在中は円を出して時間の経過を見せる
  const maxSpeed = input.stayCircleMaxSpeed ?? 86400
  if (activeVisit && settings.speed <= maxSpeed) {
    layers.push(
      new ScatterplotLayer<Visit>({
        id: 'playback-stay',
        data: [activeVisit],
        getPosition: (v) => [v.lon, v.lat],
        getRadius: 40,
        radiusUnits: 'pixels',
        radiusMinPixels: 6,
        radiusMaxPixels: 60,
        stroked: true,
        filled: true,
        getFillColor: [94, 234, 212, 40],
        getLineColor: [94, 234, 212, 200],
        lineWidthMinPixels: 1.5,
        updateTriggers: { getPosition: activeVisit.start },
      }),
    )
  }

  return layers
}
