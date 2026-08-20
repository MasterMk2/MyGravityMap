import type { Layer } from '@deck.gl/core'
import { HeatmapLayer, HexagonLayer } from '@deck.gl/aggregation-layers'
import { aggregateToCells, type GravitySource, type WeightedPoints } from './weights'

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
const heatCache = new WeakMap<Float32Array, Map<number, WeightedPoints>>()

/**
 * 滞在時間 → 表示用の重み。分に直してから log1p を取る。
 *
 * 自宅は他の場所より 3〜4 桁大きいので、線形のままだと自宅以外が
 * すべて最小色に潰れる。対数にすると「1 時間 と 10 時間 と 100 時間」が
 * 等間隔に並び、たまにしか行かない場所も見えるようになる。
 */
function toLog(seconds: number): number {
  return Math.log1p(seconds / 60)
}

/** ヒートマップ用に格子へまとめた点（格子サイズごとにキャッシュ） */
function heatPoints(points: WeightedPoints, cellMeters: number): WeightedPoints {
  let byCell = heatCache.get(points.weights)
  if (!byCell) {
    byCell = new Map()
    heatCache.set(points.weights, byCell)
  }
  const cached = byCell.get(cellMeters)
  if (cached) return cached
  const cells = aggregateToCells(points, cellMeters)
  const logged: WeightedPoints = {
    positions: cells.positions,
    weights: cells.weights.map(toLog),
    count: cells.count,
    totalSeconds: cells.totalSeconds,
  }
  byCell.set(cellMeters, logged)
  return logged
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
  /** ビンの合計滞在秒数を対数に写す。集計の「後」に掛けるのが肝 */
  const logOfBin = (bin: number[]) => {
    let sum = 0
    for (const i of bin) sum += points.weights[i] ?? 0
    return toLog(sum)
  }

  if (mode === 'heat' || mode === 'both') {
    // ヒートマップは 150m の格子にまとめてから描く（点の密度の偏りを消すため）
    const heat = heatPoints(points, 150)
    const heatIndices = indexData(heat)
    layers.push(
      new HeatmapLayer<number>({
        id: 'gravity-heat',
        data: heatIndices,
        getPosition: (i: number) => [
          heat.positions[i * 2] ?? 0,
          heat.positions[i * 2 + 1] ?? 0,
        ],
        getWeight: (i: number) => heat.weights[i] ?? 0,
        /*
         * MEAN であって SUM ではない。
         * 事前に等面積の格子へまとめてあるので 1 マス 1 点になっており、
         * SUM だと画素に入るマスの数（＝ズーム）で明るさが変わってしまう。
         * MEAN なら「そのあたりの 1 マスあたりの滞在時間」を見ることになり、
         * ズームを変えても意味が変わらない。
         */
        aggregation: 'MEAN',
        radiusPixels: 44,
        intensity,
        // 対数にしてあるので、低い側も拾えるよう既定（0.05）より下げる
        threshold: 0.01,
        colorRange: COLOR_RANGE,
        opacity,
        updateTriggers: { getPosition: heat.positions, getWeight: heat.weights },
      }),
    )
  }

  if (mode === 'hex' || mode === 'both') {
    layers.push(
      new HexagonLayer<number>({
        id: 'gravity-hex',
        data,
        getPosition: positionOf,
        /*
         * 集計「後」に対数を掛ける。
         *
         * getColorWeight + colorAggregation:'SUM' だと合計値がそのまま
         * elevationRange へ線形に写されるため、自宅が 3〜4 桁大きいこの手の
         * データでは自宅以外の柱が地面に張り付いてしまう。
         * ビンごとの合計を log1p に写してから写像させると、
         * 「1 時間 / 10 時間 / 100 時間」が等間隔に並ぶ。
         */
        getColorValue: logOfBin,
        getElevationValue: logOfBin,
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
        // 対数にした時点で外れ値は十分潰れているので、頭打ちはしない。
        // ここで切ると自宅と職場の差まで消えてしまう。
        elevationLowerPercentile: 0,
        elevationUpperPercentile: 100,
        upperPercentile: 100,
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
          getColorValue: points.weights,
          getElevationValue: points.weights,
        },
      }),
    )
  }

  return layers
}
