import type { Layer } from '@deck.gl/core'
import { HeatmapLayer, HexagonLayer } from '@deck.gl/aggregation-layers'
import type { GravitySource, WeightedPoints } from './weights'

export type GravityMode = 'off' | 'heat' | 'hex' | 'both'

export interface GravitySettings {
  mode: GravityMode
  source: GravitySource
  /** 六角柱の 1 マスの半径（メートル） */
  radiusMeters: number
  /** 見た目の強さ 0..2 */
  intensity: number
  opacity: number
}

export const DEFAULT_GRAVITY: GravitySettings = {
  mode: 'off',
  source: 'track',
  radiusMeters: 250,
  intensity: 1,
  opacity: 0.85,
}

export interface GravityLayerInput {
  mode: GravityMode
  points: WeightedPoints
  /** 六角柱の 1 マスの半径（メートル） */
  radiusMeters: number
  /** 見た目の強さ 0..2 */
  intensity: number
  /** 軌跡の下に敷くので控えめにできるようにする */
  opacity: number
}

/**
 * 重力＝滞在時間の色。暗い青緑から白へ。
 * 暗い基図の上でも軌跡の色（年ごとの色相）と喧嘩しないよう、
 * 低い側は彩度を落とし、高い側だけ白く飛ばす。
 */
const COLOR_RANGE: Array<[number, number, number]> = [
  [12, 44, 64],
  [20, 92, 110],
  [26, 146, 140],
  [86, 196, 154],
  [186, 230, 160],
  [255, 255, 235],
]

/**
 * データは「添字の配列」として渡し、座標も重みも添字で引く。
 *
 * 実データでは軌跡だけで 11 万点あるので 1 点ずつオブジェクトを作りたくない。
 * かといってバイナリ属性（data.attributes）で渡すと HexagonLayer の CPU 集計が
 * 座標を拾えず、柱が 1 本も出なかった。添字配列なら軽さと確実さの両方が取れる。
 */
const indexCache = new WeakMap<Float32Array, number[]>()

function indexData(points: WeightedPoints): number[] {
  const cached = indexCache.get(points.positions)
  if (cached && cached.length === points.count) return cached
  const arr = new Array<number>(points.count)
  for (let i = 0; i < points.count; i++) arr[i] = i
  indexCache.set(points.positions, arr)
  return arr
}

export function buildGravityLayers(input: GravityLayerInput): Layer[] {
  const { mode, points, radiusMeters, intensity, opacity } = input
  if (mode === 'off' || points.count === 0) return []

  const layers: Layer[] = []
  const data = indexData(points)
  const positionOf = (i: number): [number, number] => [
    points.positions[i * 2] ?? 0,
    points.positions[i * 2 + 1] ?? 0,
  ]
  const weightOf = (i: number) => points.weights[i] ?? 0

  if (mode === 'heat' || mode === 'both') {
    layers.push(
      new HeatmapLayer<number>({
        id: 'gravity-heat',
        data,
        getPosition: positionOf,
        getWeight: weightOf,
        aggregation: 'SUM',
        radiusPixels: 34,
        intensity,
        // 上位 1% を頭打ちにしないと、自宅の 1 マスだけが赤でほかが全部黒になる
        threshold: 0.03,
        colorRange: COLOR_RANGE,
        opacity,
        updateTriggers: { getWeight: points.weights },
      }),
    )
  }

  if (mode === 'hex' || mode === 'both') {
    layers.push(
      new HexagonLayer<number>({
        id: 'gravity-hex',
        data,
        getPosition: positionOf,
        getColorWeight: weightOf,
        getElevationWeight: weightOf,
        colorAggregation: 'SUM',
        elevationAggregation: 'SUM',
        radius: radiusMeters,
        extruded: true,
        /*
         * HexagonLayer は集計値をまず elevationRange（既定 [0, 1000] メートル）に
         * 写してから elevationScale を掛ける。つまり最も高い柱の高さは
         * 1000 × elevationScale メートルであって、滞在秒数そのものではない。
         * ここを取り違えて 0.06 を指定していたため、最大でも 60m しかなく
         * どのズームでもほぼ見えなかった。
         *
         * 柱の太さ（radius）に対して見合う高さになるよう、半径基準で決める。
         * 250m 粒度なら最大 2.5km、1km 粒度なら最大 10km。
         */
        elevationScale: (radiusMeters * 10 * intensity) / 1000,
        elevationLowerPercentile: 0,
        elevationUpperPercentile: 99,
        upperPercentile: 99,
        colorRange: COLOR_RANGE,
        coverage: 0.86,
        opacity: mode === 'both' ? opacity * 0.85 : opacity,
        pickable: false,
        material: {
          ambient: 0.7,
          diffuse: 0.5,
          shininess: 24,
          specularColor: [255, 255, 255],
        },
        updateTriggers: {
          getColorWeight: points.weights,
          getElevationWeight: points.weights,
        },
      }),
    )
  }

  return layers
}
