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
 * deck.gl の集計レイヤーにはバイナリ属性で渡す。
 * 実データでは軌跡だけで 118,405 点あり、1 点ずつオブジェクトにすると
 * 生成にも GC にも無駄が出る。
 */
function binaryData(points: WeightedPoints) {
  return {
    length: points.count,
    attributes: {
      getPosition: { value: points.positions, size: 2 },
    },
  }
}

export function buildGravityLayers(input: GravityLayerInput): Layer[] {
  const { mode, points, radiusMeters, intensity, opacity } = input
  if (mode === 'off' || points.count === 0) return []

  const layers: Layer[] = []
  const data = binaryData(points)
  const weightOf = (_: unknown, info: { index: number }) => points.weights[info.index] ?? 0

  if (mode === 'heat' || mode === 'both') {
    layers.push(
      new HeatmapLayer({
        id: 'gravity-heat',
        data,
        getPosition: (d: unknown) => d as unknown as [number, number],
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
      new HexagonLayer({
        id: 'gravity-hex',
        data,
        getPosition: (d: unknown) => d as unknown as [number, number],
        getColorWeight: weightOf,
        getElevationWeight: weightOf,
        colorAggregation: 'SUM',
        elevationAggregation: 'SUM',
        radius: radiusMeters,
        extruded: true,
        // 滞在時間の分布は自宅が突出するので、対数的に潰さないと
        // ほかの柱が地面に張り付いて見えなくなる
        elevationScale: 0.06 * intensity,
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
