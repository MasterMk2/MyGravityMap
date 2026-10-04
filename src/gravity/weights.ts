/**
 * 重力マップの元になる「重み付きの点」を作る。
 *
 * ヒートマップも六角柱も、重みの意味は同じ「そこに居た秒数」で揃える。
 * 表現が違うだけで測っているものは同じ、という状態にしておかないと、
 * 2 つの絵を並べたときに読み方が変わってしまう。
 *
 * 元データは 3 通り:
 *
 * - 日数（既定。DESIGN.md §2 の頻度モード）: その場所に居た「日数」。同じ日の再訪は 1 日に丸める。
 *   記録の濃さ（2019 年は 1 日 6 時間分、2025 年は 15 時間分）に左右されにくいので、
 *   全期間を同じ土俵で比べられる。これだけは重みの単位が秒ではなく日。
 * - 軌跡（timelinePath 由来）: 全期間で使えるが、点の間隔から滞在時間を
 *   推定するので粗い。年ごとに記録の濃さが違う点にも注意（DESIGN.md §1.2.1）。
 * - 滞在（Google の visit）: 滞在時間そのものなので正確だが、
 *   2024 年秋以降にしか存在しない。
 */
import type { Dataset, TimeWindow, Trip, Visit } from '../core/types'
import { haversineMeters, localDayKey } from '../core/geo'
import { createTzLookup, type TzLookup } from '../core/timezone'
import { normalizeYearlyCells, type GravityNormalization } from './normalization'

export type GravitySource = 'days' | 'track' | 'visit'

export interface WeightedPoints {
  /** [lon, lat, lon, lat, ...] */
  positions: Float32Array
  /** 各点の重み。単位は unit */
  weights: Float32Array
  count: number
  /** 重みの合計（unit の単位。日数なら延べ日数） */
  total: number
  /** 'seconds': 居た秒数 / 'days': 居た日数 */
  unit: 'seconds' | 'days' | 'percentile'
}

const EMPTY: WeightedPoints = {
  positions: new Float32Array(0),
  weights: new Float32Array(0),
  count: 0,
  total: 0,
  unit: 'seconds',
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
 * 飛行区間のうち、この距離を超える区間は重力マップに載せない。
 *
 * 長距離移動は記録が飛んだところを大圏コースで補ってあるが、それは
 * 「そこに居た」わけではなく「その上空を通った」だけ。塗ると海の上や
 * 他人の街に光の帯ができる。実際、欧州便は 600 秒ごとの補間点が
 * 113km 間隔で並ぶため、地図上に点線として出ていた。
 *
 * 同じ飛行トリップでも空港周辺の実際の記録は点の間隔が短いので、
 * 距離でしきい値を切れば残せる。
 */
const FLIGHT_SEGMENT_MIN_METERS = 2000

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

      // 上空を通っただけの区間は載せない（点線として地図に出てしまうため）
      if (trip.isFlight && meters > FLIGHT_SEGMENT_MIN_METERS) continue
      if (kmh > DENSIFY_MAX_KMH) continue

      if (meters <= DENSIFY_STEP_METERS) {
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
    total: seconds,
    unit: 'seconds',
  }
}

/**
 * その訪問を「滞在」の重みに使ってよいか。
 *
 * - hierarchyLevel 1 は level 0 と時間が重複する（実データで 623 件中 622 件）ので、
 *   二重計上を避けるため level 0 のみを使う。
 * - durationReliable でない訪問（軌跡から復元した derived）は滞在時間を数値として
 *   信用できないので、秒数を重みにする重力マップには載せない。
 */
function usableAsWeight(v: Visit, w: TimeWindow): boolean {
  return v.hierarchyLevel === 0 && v.durationReliable && overlaps(v.start, v.end, w)
}

/**
 * その期間に「滞在」ソースで描けるものがあるか。UI の可否判定はこれを使う。
 *
 * visitWeights と同じ条件を通すことが要点で、条件を書き写して別々に持つと
 * 「選べるのに中身が空」という食い違いがそのまま UI に出る。
 */
export function hasVisitWeights(visits: Visit[], w: TimeWindow): boolean {
  return visits.some((v) => usableAsWeight(v, w))
}

/**
 * Google の visit を滞在秒数で重み付けする。
 */
export function visitWeights(visits: Visit[], w: TimeWindow): WeightedPoints {
  const target = visits.filter((v) => usableAsWeight(v, w))
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

  return { positions, weights, count: target.length, total: seconds, unit: 'seconds' }
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

  const cells = new Map<string, { lon: number; lat: number; w: number }>()

  for (let i = 0; i < points.count; i++) {
    const lon = points.positions[i * 2]!
    const lat = points.positions[i * 2 + 1]!
    const w = points.weights[i]!
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(lon) || !Number.isFinite(lat)) continue
    const key = cellKey(lat, lon, cellMeters)
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
  let total = 0
  for (const c of cells.values()) {
    // 重み 0 の点しか無いマスは重心が出せないので中心をそのまま使えない。
    // 実際には weights は必ず正だが、念のため 0 除算を避ける。
    const d = c.w > 0 ? c.w : 1
    positions[i * 2] = c.lon / d
    positions[i * 2 + 1] = c.lat / d
    weights[i] = c.w
    total += c.w
    i++
  }

  return { positions, weights, count: cells.size, total, unit: points.unit }
}

/** 等面積の格子のキー。経度の刻みは緯度で縮むので、高緯度でマスが横に伸びないように補正する */
function cellKey(lat: number, lon: number, cellMeters: number): string {
  const latStep = cellMeters / 111_320
  const lonStep = cellMeters / (111_320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)))
  return `${Math.round(lat / latStep)}:${Math.round(lon / lonStep)}`
}

/**
 * 「居た」とみなす軌跡の点の速さの上限（km/h）。
 *
 * 日数モードは「通った」ではなく「居た」を数えたい。すべての点を数えると、
 * 毎日通る通勤路が自宅と同じだけ重くなる。次の点までの平均速度がこれ未満の点だけを
 * 滞在の点とみなす（徒歩は 4〜5 km/h なので、歩いている途中は数えない）。
 */
const STAY_MAX_KMH = 2

/** 速さを信用する最短の間隔。数秒おきの点は位置のぶれで速度が暴れる */
const STAY_MIN_DT_SEC = 120

/** 1 件の訪問から数える日数の上限。壊れた長大な訪問で暴走しないように */
const MAX_DAYS_PER_VISIT = 62

/**
 * 格子のマスごとに「居た日数」を数える（頻度モード）。
 *
 * 1 マス × 1 日（記録側の暦日）を 1 回だけ数える。材料は 2 つ:
 * - 訪問（hierarchyLevel 0。Google 由来も軌跡から復元した derived も使う）。
 *   derived は滞在時間こそ信用できないが、「その日そこに居た」事実は使える（DESIGN.md §1.2.1）。
 * - 軌跡の点のうち、ほぼ止まっていた点（STAY_MAX_KMH）。
 *
 * 位置は数えた点の平均。重みは日数（unit: 'days'）。
 * 六角柱やヒートマップでさらに粗いマスへ束ねると、束ねたマスどうしの日数を足すので
 * 「延べ日数」になる（同じ日に隣のマスにも居れば 2 と数える）。
 */
export function dayWeights(
  trips: Trip[],
  visits: Visit[],
  w: TimeWindow,
  tzOf: TzLookup,
  cellMeters: number,
): WeightedPoints {
  const cells = new Map<string, { lon: number; lat: number; n: number; days: Set<string> }>()

  const add = (lon: number, lat: number, day: string) => {
    const key = cellKey(lat, lon, cellMeters)
    let c = cells.get(key)
    if (!c) cells.set(key, (c = { lon: 0, lat: 0, n: 0, days: new Set() }))
    c.lon += lon
    c.lat += lat
    c.n += 1
    c.days.add(day)
  }

  for (const v of visits) {
    if (v.hierarchyLevel !== 0 || !overlaps(v.start, v.end, w)) continue
    // Google の訪問は自分の TZ を持っている。derived は持っていないので引く。
    const tz = v.source === 'google' ? v.tzOffsetMin : tzOf(v.start)
    const from = Math.max(v.start, w.start)
    const to = Math.min(v.end, w.end)
    let day = localDayKey(from, tz)
    add(v.lon, v.lat, day)
    // 日をまたぐ滞在（泊まり）は、またいだ日もすべて数える
    for (let t = from + 86400, k = 1; t < to && k < MAX_DAYS_PER_VISIT; t += 86400, k++) {
      day = localDayKey(t, tz)
      add(v.lon, v.lat, day)
    }
    const last = localDayKey(Math.max(from, to - 1), tz)
    if (last !== day) add(v.lon, v.lat, last)
  }

  for (const trip of trips) {
    const len = trip.times.length
    for (let i = 0; i + 1 < len; i++) {
      const t = trip.times[i]!
      if (t < w.start || t > w.end) continue
      const dt = trip.times[i + 1]! - t
      if (dt < STAY_MIN_DT_SEC) continue
      const lon = trip.coords[i * 2]!
      const lat = trip.coords[i * 2 + 1]!
      const meters = haversineMeters(lat, lon, trip.coords[(i + 1) * 2 + 1]!, trip.coords[(i + 1) * 2]!)
      if (meters / 1000 / (dt / 3600) >= STAY_MAX_KMH) continue
      add(lon, lat, localDayKey(t, tzOf(t)))
    }
  }

  if (cells.size === 0) return { ...EMPTY, unit: 'days' }

  const positions = new Float32Array(cells.size * 2)
  const weights = new Float32Array(cells.size)
  let i = 0
  let total = 0
  for (const c of cells.values()) {
    positions[i * 2] = c.lon / c.n
    positions[i * 2 + 1] = c.lat / c.n
    weights[i] = c.days.size
    total += c.days.size
    i++
  }
  return { positions, weights, count: cells.size, total, unit: 'days' }
}

function rawWeightedPoints(
  dataset: Dataset | null,
  trips: Trip[],
  window: TimeWindow,
  source: GravitySource,
  /** 日数モードで日を数えるマスの大きさ（メートル）。粒度と揃える */
  cellMeters: number,
): WeightedPoints {
  if (!dataset) return EMPTY
  if (source === 'visit') return visitWeights(dataset.visits, window)
  if (source === 'days') {
    return dayWeights(trips, dataset.visits, window, createTzLookup(dataset.tzChanges), cellMeters)
  }
  return trackWeights(trips, window)
}


/** Normalize independently within each UTC calendar year intersecting the selection.
 * Raw mode is unchanged. Missing source years are excluded by normalizeYearlyCells.
 */
export function buildWeightedPoints(
  dataset: Dataset | null, trips: Trip[], window: TimeWindow, source: GravitySource,
  cellMeters: number, normalization: GravityNormalization = 'raw',
): WeightedPoints {
  if (!dataset || normalization === 'raw') return rawWeightedPoints(dataset, trips, window, source, cellMeters)
  if (!(cellMeters > 0) || !Number.isFinite(cellMeters)) throw new RangeError('粒度は正の有限数で指定してください')
  const start = Math.max(window.start, dataset.tMin)
  const end = Math.min(window.end, dataset.tMax)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return { ...EMPTY, unit: 'percentile' }
  const from = new Date(start * 1000).getUTCFullYear()
  const to = new Date(end * 1000).getUTCFullYear()
  const years: WeightedPoints[] = []
  for (let year = from; year <= to; year++) {
    const yearStart = Date.UTC(year, 0, 1) / 1000
    const yearEnd = Date.UTC(year + 1, 0, 1) / 1000
    // Track samples are integer seconds and existing raw builders include their right endpoint.
    // Keep Jan 1 samples out of the preceding year without losing the selected endpoint.
    const selection = { start: Math.max(start, yearStart), end: Math.min(end, yearEnd - 0.001) }
    if (selection.end >= selection.start) years.push(rawWeightedPoints(dataset, trips, selection, source, cellMeters))
  }
  return normalizeYearlyCells(years, cellMeters)
}
