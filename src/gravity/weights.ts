/**
 * 重力マップの元になる「重み付きの点」を作る。
 *
 * ヒートマップも六角柱も、重みの意味は同じ「そこに居た秒数」で揃える。
 * 表現が違うだけで測っているものは同じ、という状態にしておかないと、
 * 2 つの絵を並べたときに読み方が変わってしまう。
 *
 * 元データは 2 通り:
 *
 * - 軌跡（timelinePath 由来）: 全期間で使えるが、点の間隔から滞在時間を
 *   推定するので粗い。年ごとに記録の濃さが違う点にも注意（DESIGN.md §1.2.1）。
 * - 滞在（Google の visit）: 滞在時間そのものなので正確だが、
 *   2024 年秋以降にしか存在しない。
 */
import type { Dataset, TimeWindow, Trip, Visit } from '../core/types'
import { haversineMeters } from '../core/geo'

export type GravitySource = 'track' | 'visit'

export interface WeightedPoints {
  /** [lon, lat, lon, lat, ...] */
  positions: Float32Array
  /** 各点が表す秒数 */
  weights: Float32Array
  count: number
  totalSeconds: number
}

const EMPTY: WeightedPoints = {
  positions: new Float32Array(0),
  weights: new Float32Array(0),
  count: 0,
  totalSeconds: 0,
}

/**
 * 1 点が表せる最大の秒数。
 * 軌跡の点は間隔がばらばらなので「次の点までの時間」を重みにするが、
 * 上限を設けないと、記録が飛んだ区間の直前の 1 点が何時間分もの重みを持ち、
 * 実際には居なかった場所に巨大な山ができる。
 * 軌跡の分割閾値（30 分）と揃えてある。
 */
const MAX_SECONDS_PER_POINT = 1800

function overlaps(aStart: number, aEnd: number, w: TimeWindow): boolean {
  return aStart < w.end && aEnd > w.start
}

/**
 * 補間の刻み（メートル）。
 *
 * 記録された点の間隔は中央値 437m、p90 で 2.6km ある。移動中の点をそのまま置くと、
 * 等速で走った区間が数 km おきの数珠つなぎになって「点々」に見える。
 * 区間を刻んで、そのあいだの滞在時間を等分して配れば連続した線になる。
 * 250m 刻みで全期間 10 万区間・10.3 万 km を埋めると約 48 万点。
 */
const DENSIFY_STEP_METERS = 250

/**
 * これより速い区間は補間しない。
 * 飛行機の大圏補間区間まで塗ると、通っただけの空の上に太い帯ができてしまう。
 */
const DENSIFY_MAX_KMH = 200

/** 1 区間から作る点数の上限。記録が飛んだ長い区間で暴走しないように */
const MAX_STEPS_PER_SEGMENT = 512

/**
 * 軌跡の点を「次の点までの秒数」で重み付けし、区間の途中も埋める。
 *
 * 重みの単位は秒のまま。区間を n 個に刻んだら、その区間の秒数も n 等分するので、
 * 合計滞在時間は補間しても変わらない。
 */
export function trackWeights(trips: Trip[], w: TimeWindow): WeightedPoints {
  const lons: number[] = []
  const lats: number[] = []
  const weights: number[] = []
  let seconds = 0

  const push = (lon: number, lat: number, sec: number) => {
    lons.push(lon)
    lats.push(lat)
    weights.push(sec)
    seconds += sec
  }

  for (const trip of trips) {
    const len = trip.times.length
    for (let i = 0; i < len; i++) {
      const t = trip.times[i]!
      if (t < w.start || t > w.end) continue

      const lon = trip.coords[i * 2]!
      const lat = trip.coords[i * 2 + 1]!

      if (i + 1 >= len) {
        // 最後の点は次の間隔が分からないので控えめに 60 秒とする
        push(lon, lat, 60)
        continue
      }

      const dt = Math.min(trip.times[i + 1]! - t, MAX_SECONDS_PER_POINT)
      const lon2 = trip.coords[(i + 1) * 2]!
      const lat2 = trip.coords[(i + 1) * 2 + 1]!
      const meters = haversineMeters(lat, lon, lat2, lon2)
      const kmh = dt > 0 ? meters / 1000 / (dt / 3600) : 0

      if (meters <= DENSIFY_STEP_METERS || kmh > DENSIFY_MAX_KMH) {
        push(lon, lat, dt)
        continue
      }

      const steps = Math.min(Math.ceil(meters / DENSIFY_STEP_METERS), MAX_STEPS_PER_SEGMENT)
      const share = dt / steps
      // 終点は置かない（次の点が自分で置くので、置くと二重になる）
      for (let k = 0; k < steps; k++) {
        const f = k / steps
        push(lon + (lon2 - lon) * f, lat + (lat2 - lat) * f, share)
      }
    }
  }

  if (weights.length === 0) return EMPTY

  const positions = new Float32Array(weights.length * 2)
  for (let i = 0; i < weights.length; i++) {
    positions[i * 2] = lons[i]!
    positions[i * 2 + 1] = lats[i]!
  }

  return {
    positions,
    weights: Float32Array.from(weights),
    count: weights.length,
    totalSeconds: seconds,
  }
}

/**
 * Google の visit を滞在秒数で重み付けする。
 * hierarchyLevel 1 は level 0 と時間が重複する（実データで 623 件中 622 件）ので、
 * 二重計上を避けるため level 0 のみを使う。
 */
export function visitWeights(visits: Visit[], w: TimeWindow): WeightedPoints {
  const target = visits.filter(
    (v) => v.hierarchyLevel === 0 && v.durationReliable && overlaps(v.start, v.end, w),
  )
  if (target.length === 0) return EMPTY

  const positions = new Float32Array(target.length * 2)
  const weights = new Float32Array(target.length)
  let seconds = 0

  target.forEach((v, i) => {
    positions[i * 2] = v.lon
    positions[i * 2 + 1] = v.lat
    // 期間からはみ出した分は数えない
    const s = Math.max(0, Math.min(v.end, w.end) - Math.max(v.start, w.start))
    weights[i] = s
    seconds += s
  })

  return { positions, weights, count: target.length, totalSeconds: seconds }
}

/**
 * 点を等面積の格子にまとめて、1 マス 1 点にする。
 *
 * ヒートマップは画素ごとに重みを足し込むので、生の点をそのまま渡すと
 * 「滞在時間が長い」ではなく「点が密に記録されている」場所が光ってしまう。
 * 先に格子へまとめておけば 1 マス 1 点になり、点の密度の偏りが消える。
 *
 * 位置は滞在時間で加重した重心。
 */
export function aggregateToCells(points: WeightedPoints, cellMeters: number): WeightedPoints {
  if (points.count === 0) return EMPTY

  const latStep = cellMeters / 111_320
  const cells = new Map<string, { lon: number; lat: number; w: number }>()

  for (let i = 0; i < points.count; i++) {
    const lon = points.positions[i * 2]!
    const lat = points.positions[i * 2 + 1]!
    const w = points.weights[i]!
    // 経度の刻みは緯度で縮む。高緯度でマスが横に伸びないように補正する。
    const lonStep = cellMeters / (111_320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)))
    const key = `${Math.round(lat / latStep)}:${Math.round(lon / lonStep)}`
    const cell = cells.get(key)
    if (cell) {
      cell.lon += lon * w
      cell.lat += lat * w
      cell.w += w
    } else {
      cells.set(key, { lon: lon * w, lat: lat * w, w })
    }
  }

  const positions = new Float32Array(cells.size * 2)
  const weights = new Float32Array(cells.size)
  let i = 0
  let totalSeconds = 0
  for (const c of cells.values()) {
    // 重み 0 の点しか無いマスは重心が出せないので中心をそのまま使えない。
    // 実際には weights は必ず正だが、念のため 0 除算を避ける。
    const d = c.w > 0 ? c.w : 1
    positions[i * 2] = c.lon / d
    positions[i * 2 + 1] = c.lat / d
    weights[i] = c.w
    totalSeconds += c.w
    i++
  }

  return { positions, weights, count: cells.size, totalSeconds }
}

export function buildWeightedPoints(
  dataset: Dataset | null,
  trips: Trip[],
  window: TimeWindow,
  source: GravitySource,
): WeightedPoints {
  if (!dataset) return EMPTY
  return source === 'visit' ? visitWeights(dataset.visits, window) : trackWeights(trips, window)
}
