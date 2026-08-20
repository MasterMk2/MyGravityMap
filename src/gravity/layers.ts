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
const logWeightCache = new WeakMap<Float32Array, Float32Array>()

/**
 * ヒートマップ用に重みを対数圧縮する。
 *
 * HeatmapLayer は画素ごとに重みを足し込み、その最大値で正規化してから
 * threshold 未満を透明にする。滞在時間は自宅が桁違いに大きいので、
 * 生の秒数のままだと自宅の一点だけが残り、他は全部 threshold を下回って
 * 何も描かれていないように見える。
 *
 * 六角柱の側はパーセンタイルで頭打ちにできるので生の秒数のまま使う。
 */
function logWeights(weights: Float32Array): Float32Array {
  const cached = logWeightCache.get(weights)
  if (cached) return cached
  const out = new Float32Array(weights.length)
  for (let i = 0; i < weights.length; i++) out[i] = Math.log1p(weights[i]! / 60)
  logWeightCache.set(weights, out)
  return out
}

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
  const heatWeights = logWeights(points.weights)

  if (mode === 'heat' || mode === 'both') {
    layers.push(
      new HeatmapLayer<number>({
        id: 'gravity-heat',
        data,
        getPosition: positionOf,
        getWeight: (i: number) => heatWeights[i] ?? 0,
        aggregation: 'SUM',
        radiusPixels: 40,
        intensity,
        // 対数圧縮したうえで、さらに低い側も拾えるよう既定より下げる
        threshold: 0.01,
        colorRange: COLOR_RANGE,
        opacity,
        updateTriggers: { getWeight: heatWeights },
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
         * GPU 集計を使わない。
         *
         * HexagonLayer の既定は gpuAggregation: true で、これは点の広がりから
         * 格子テクスチャを作る。この履歴は日本と欧州にまたがっていて
         * 経度で 130 度以上の広がりがあるため、250m 粒度だと格子が巨大になりすぎ、
         * 柱が 1 本も出ない（例外も警告も出ない）。
         * 実際、日本国内に収まる「滞在」では出て、欧州を含む「軌跡」では出なかった。
         *
         * CPU 集計はハッシュで binning するので広がりに影響されない。
         * 点数は最大でも 11 万程度なので CPU で十分間に合う。
         */
        gpuAggregation: false,
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
