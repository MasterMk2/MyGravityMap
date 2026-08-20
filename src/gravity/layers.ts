import type { Layer } from '@deck.gl/core'
import { HeatmapLayer, HexagonLayer } from '@deck.gl/aggregation-layers'
import { aggregateToCells, type GravitySource, type WeightedPoints } from './weights'

export type GravityMode = 'off' | 'heat' | 'hex' | 'both'

export interface GravitySettings {
  mode: GravityMode
  source: GravitySource
  /** 六角柱の 1 マスの半径（メートル） */
  radiusMeters: number
  /** 見た目の強さ 0.5..8。色は 重み × これ ÷ 最大値 で引かれる */
  intensity: number
  /** 対数に掛けるガンマ 0.3..1.5。小さいほど弱い場所が持ち上がる */
  contrast: number
  opacity: number
}

export const DEFAULT_GRAVITY: GravitySettings = {
  mode: 'off',
  source: 'track',
  radiusMeters: 250,
  // ヒートマップの色は「重み ÷ 最大値」の線形なので、1 だと弱い側が
  // 色の最下段に張り付く。3 なら最大値の 1/3 で白まで届く。
  intensity: 3,
  contrast: 0.6,
  opacity: 0.85,
}

export interface GravityLayerInput {
  mode: GravityMode
  points: WeightedPoints
  /** 六角柱の 1 マスの半径（メートル） */
  radiusMeters: number
  /** 見た目の強さ 0.5..8。色は 重み × これ ÷ 最大値 で引かれる */
  intensity: number
  /** 対数に掛けるガンマ 0.3..1.5 */
  contrast: number
  /** 軌跡の下に敷くので控えめにできるようにする */
  opacity: number
  /** 現在のズーム。ヒートマップの格子の大きさを決めるのに使う */
  zoom: number
  /** 画面中央あたりの緯度。1 画素が何メートルかは緯度で変わる */
  latitude: number
}

/*
 * 引きのときの 1 マスの大きさ（画面上の画素数）。
 *
 * 画素あたりのマス数は (光の半径 ÷ マスの大きさ)^2 で効くので、ここが値の広がりを
 * 直接決める。半径 32px のとき、マス 2px なら市街地と道路沿いで 25:1 の差がつくが、
 * 6px なら 8:1 まで縮む。マスを大きくするほど「よく行く場所」と
 * 「たまに通る道」の差が縮まり、弱い側が見えるようになる。
 */
const CELL_PIXELS = 6

/** そのズームで画面 1 画素が地上何メートルにあたるか */
function metersPerPixel(zoom: number, latitude: number): number {
  return (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom
}

/** 1・2・5 × 10^n に丸める。格子サイズのキャッシュが効くようにするため */
function roundToNice(v: number): number {
  if (!(v > 0)) return 1
  const exp = Math.floor(Math.log10(v))
  const base = 10 ** exp
  const m = v / base
  const nice = m <= 1.5 ? 1 : m <= 3.5 ? 2 : m <= 7.5 ? 5 : 10
  return nice * base
}

/**
 * ヒートマップの格子の大きさ。
 *
 * SUM は重なった点を足し合わせるので、引いて見ると 1 画素に入るマスの数が増え、
 * どんどん明るくなってしまう。マスを画素の大きさに追随させれば、
 * どのズームでも「1 画素あたりのマス数」がほぼ変わらず、明るさが安定する。
 *
 * 寄って見ているときは利用者が選んだ粒度をそのまま使う（そちらの方が細かいため）。
 */
export function heatCellMeters(radiusMeters: number, zoom: number, latitude: number): number {
  const mpp = metersPerPixel(zoom, latitude)
  // ズーム由来の値だけを丸める。粒度は利用者が選んだ値をそのまま尊重したい。
  return Math.max(radiusMeters, roundToNice(mpp * CELL_PIXELS))
}

/*
 * ヒートマップの色。低い側ほど透明にしていく。
 * 低い側に濃い色を置くと、弱い場所が「暗い塊」として地図の上に乗り、
 * 輪郭が縁取りのように見えて汚くなる。不透明度で抜けば地図に溶けて消える。
 *
 * 段の並びは「色の割り当て」そのものになる。
 *
 * シェーダは color = colorTexture[clamp(重み × intensity ÷ 最大値, 0, 1)] という
 * 線形の引き方をするので、段を均等に置くと弱い側が最下段に張り付く。
 * 実データは自宅が突出しているぶん、大半の場所が下から 1〜2 割の範囲に入る。
 * そこで前半に段を厚く配り、序盤で一気に色がつくようにしてある。
 */
const HEAT_COLORS: Array<[number, number, number, number]> = [
  [21, 101, 138, 0],
  [24, 138, 158, 70],
  [28, 170, 158, 130],
  [40, 196, 150, 175],
  [86, 214, 140, 205],
  [150, 228, 134, 226],
  [214, 240, 132, 242],
  [255, 255, 245, 255],
]

/**
 * 六角柱の色。こちらは柱そのものなので透明にはしない。
 * 低い柱も見えている必要がある。
 */
const HEX_COLORS: Array<[number, number, number]> = [
  [20, 92, 110],
  [26, 146, 140],
  [45, 195, 152],
  [130, 222, 128],
  [214, 240, 130],
  [255, 255, 245],
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
function toLog(seconds: number, contrast: number): number {
  return Math.pow(Math.log1p(seconds / 60), contrast)
}

/** ヒートマップ用に格子へまとめた点（格子サイズごとにキャッシュ） */
function heatPoints(points: WeightedPoints, cellMeters: number, contrast: number): WeightedPoints {
  let byCell = heatCache.get(points.weights)
  if (!byCell) {
    byCell = new Map()
    heatCache.set(points.weights, byCell)
  }
  const key = cellMeters * 1000 + contrast
  const cached = byCell.get(key)
  if (cached) return cached
  const cells = aggregateToCells(points, cellMeters)
  const logged: WeightedPoints = {
    positions: cells.positions,
    weights: cells.weights.map((w) => toLog(w, contrast)),
    count: cells.count,
    totalSeconds: cells.totalSeconds,
  }
  byCell.set(key, logged)
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
  const { mode, points, radiusMeters, intensity, contrast, opacity, zoom, latitude } = input
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
    return toLog(sum, contrast)
  }

  if (mode === 'heat' || mode === 'both') {
    // 先に格子へまとめてから描く（点の密度の偏りを消すため）。
    // マスの大きさは粒度とズームの両方から決める（heatCellMeters を参照）。
    const heat = heatPoints(points, heatCellMeters(radiusMeters, zoom, latitude), contrast)
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
         * SUM を使う。MEAN にすると輪郭が硬くなる。
         *
         * HeatmapLayer は 1 点を放射状に減衰する円として重みテクスチャへ描く。
         * SUM ならその減衰がそのまま出るので、端は自然にゼロへ向かう。
         * MEAN は「重みの合計 ÷ 寄与数」なので、分子も分母も同じように減衰する
         * ぶん円の中でほぼ一定になり、円の縁で急に値が消える。
         * 実際これで塗った所と地図の境目が切り絵のようにくっきり出ていた。
         *
         * SUM で心配なのは点の密度の偏りだが、それは事前に等面積の格子へ
         * まとめて 1 マス 1 点にしてあるので、ここでは起きない。
         */
        aggregation: 'SUM',
        // 光る範囲の広さ。狭いと道路が細い線としてしか出ず、
        // 「どのあたりで暮らしているか」が読み取りにくい。
        radiusPixels: 32,
        intensity,
        /*
         * threshold 未満の画素は描かれない＝ここが輪郭になる。
         * 色の側は最も低い段を不透明度 0 にしてあるので、
         * 切り取りは「見えなくなった後」で起きてほしい。既定 0.05 に対してかなり低くする。
         */
        threshold: 0.002,
        colorRange: HEAT_COLORS,
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
        // 強さスライダーはヒートマップ用に広い範囲を持たせてあるので、
        // 柱の高さには効きを弱めて掛ける（intensity 3 で従来の 1 倍相当）。
        elevationScale: (radiusMeters * 10 * (0.4 + intensity * 0.2)) / 1000,
        // 対数にした時点で外れ値は十分潰れているので、頭打ちはしない。
        // ここで切ると自宅と職場の差まで消えてしまう。
        elevationLowerPercentile: 0,
        elevationUpperPercentile: 100,
        upperPercentile: 100,
        colorRange: HEX_COLORS,
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
