/**
 * 生の TrackPoint 列から再生用の Trip を組み立てるパイプライン。
 * DESIGN.md §6.1 の前提（同時刻別座標の丸め・30 分ギャップ分割・長距離便の
 * 大圏補間による分割回避）を実装する。副作用なし・純粋関数のみ。
 */
import type { TrackPoint, Trip, TravelMode, Move } from './types'
import { haversineMeters, greatCircleIntermediate } from './geo'

export interface BuildTripsOptions {
  /** この秒数を超える間隔で線を切る（既定 1800 = 30 分） */
  gapSec?: number
  /** これより速く、かつ flightMinKm より遠い点対を長距離移動とみなす（既定 200） */
  flightMinKmh?: number
  /** 既定 100 */
  flightMinKm?: number
  /**
   * 速度に関係なく、これより遠い点対は長距離移動とみなす（既定 200km）。
   *
   * 速度だけで判定すると、機内で電波が切れて前後の記録も飛んでいる場合に
   * 実効速度が極端に低く出て取りこぼす。実データでは沖縄への往復が
   * 1,390km/51時間（27km/h）と 1,406km/68時間（21km/h）になり、
   * 速度条件では全く引っかからずに線が途切れていた。
   * 一方 200km を境にすると、長距離移動 5 件だけが選ばれ、
   * 「44 時間空いて 129km」のような“間に何をしたか分からない”対は除外される。
   */
  longJumpMinKm?: number
  /** 飛行区間を橋渡しするとき、どのサブギャップもこの秒数を超えないように中間点を入れる（既定 600） */
  flightMaxSubGapSec?: number
}

export interface BuildTripsResult {
  trips: Trip[]
  duplicateTimeFixed: number
  flightPointsInserted: number
}

const DEFAULT_GAP_SEC = 1800
const DEFAULT_FLIGHT_MIN_KMH = 200
const DEFAULT_FLIGHT_MIN_KM = 100
const DEFAULT_LONG_JUMP_MIN_KM = 200
const DEFAULT_FLIGHT_MAX_SUB_GAP_SEC = 600
/** 飛行区間と判定された対には、どんなに短くても最低これだけの中間点を入れる。 */
const MIN_FLIGHT_INTERMEDIATE_POINTS = 8

/** t 昇順にソートし、完全一致の重複を除去する。同時刻で座標が違う点が複数あれば
 *  最後の 1 点だけを残し、捨てた点ごとに duplicateTimeFixed を数える
 *  （完全一致の重複はカウントしない）。結果は t について厳密に単調増加する。 */
export function normalizeMonotonic(points: TrackPoint[]): {
  points: TrackPoint[]
  duplicateTimeFixed: number
} {
  const sorted = [...points].sort((a, b) => a.t - b.t)
  const result: TrackPoint[] = []
  let duplicateTimeFixed = 0

  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1].t === sorted[i].t) j++

    const kept = sorted[j]
    for (let k = i; k < j; k++) {
      const p = sorted[k]
      if (p.lat !== kept.lat || p.lon !== kept.lon) {
        duplicateTimeFixed++
      }
      // 完全一致（同じ t・同じ lat/lon）はそのまま静かに捨てる。
    }
    result.push(kept)
    i = j + 1
  }

  return { points: result, duplicateTimeFixed }
}

/** 連続する点対の実効速度が flightMinKmh を超え、かつ距離が flightMinKm を超える場合、
 *  大圏コース上に中間点を線形補間の時刻付きで挿入し、どのサブギャップも
 *  flightMaxSubGapSec を超えないようにする（最低 8 点）。入力は既に単調増加であること。
 *  拡張後の点列・挿入点数・飛行区間のインデックス範囲（拡張後の配列上、両端を含む）を返す。 */
export function bridgeFlights(
  points: TrackPoint[],
  opts?: BuildTripsOptions,
): { points: TrackPoint[]; inserted: number; flightRanges: Array<[number, number]> } {
  const flightMinKmh = opts?.flightMinKmh ?? DEFAULT_FLIGHT_MIN_KMH
  const flightMinKm = opts?.flightMinKm ?? DEFAULT_FLIGHT_MIN_KM
  const longJumpMinKm = opts?.longJumpMinKm ?? DEFAULT_LONG_JUMP_MIN_KM
  const flightMaxSubGapSec = opts?.flightMaxSubGapSec ?? DEFAULT_FLIGHT_MAX_SUB_GAP_SEC

  if (points.length === 0) return { points: [], inserted: 0, flightRanges: [] }

  const out: TrackPoint[] = [points[0]]
  let inserted = 0
  const flightRanges: Array<[number, number]> = []

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const dtSec = b.t - a.t
    const distKm = haversineMeters(a.lat, a.lon, b.lat, b.lon) / 1000
    const speedKmh = dtSec > 0 ? distKm / (dtSec / 3600) : Infinity

    const isLongDistance =
      (speedKmh > flightMinKmh && distKm > flightMinKm) || distKm > longJumpMinKm

    if (isLongDistance) {
      const startIdx = out.length - 1 // a のインデックス（拡張後の配列上）

      const neededSegments = Math.max(Math.ceil(dtSec / flightMaxSubGapSec), 1)
      // Cap so that (n+1) never exceeds dtSec: with integer-second timestamps this
      // guarantees the rounded, linearly-interpolated t's stay strictly increasing
      // (consecutive raw values are >=1s apart, so they can never round to the same
      // second). Without this cap, a short-but-fast pair (small dtSec, "at least 8
      // intermediate points") could produce duplicate rounded timestamps and break
      // Trip.times' strict-monotonic guarantee.
      const n = Math.min(
        Math.max(neededSegments - 1, MIN_FLIGHT_INTERMEDIATE_POINTS),
        Math.max(0, dtSec - 1),
      )
      const mids = greatCircleIntermediate(a.lat, a.lon, b.lat, b.lon, n)

      for (let k = 0; k < mids.length; k++) {
        const f = (k + 1) / (n + 1)
        const t = Math.round(a.t + f * dtSec)
        const [lat, lon] = mids[k]
        out.push({ t, lat, lon })
        inserted++
      }

      out.push(b)
      const endIdx = out.length - 1 // b のインデックス（拡張後の配列上）
      flightRanges.push([startIdx, endIdx])
    } else {
      out.push(b)
    }
  }

  return { points: out, inserted, flightRanges }
}

/** フルパイプライン: normalizeMonotonic -> bridgeFlights -> gapSec 超で分割 -> Trip 構築。
 *  順序が重要: 橋渡しは分割より先でなければならない。そうしないと 12 時間の大陸間便が
 *  ギャップ規則で切られ、isFlight が一度も立たなくなる。 */
export function buildTrips(points: TrackPoint[], opts?: BuildTripsOptions): BuildTripsResult {
  const gapSec = opts?.gapSec ?? DEFAULT_GAP_SEC

  const { points: normPoints, duplicateTimeFixed } = normalizeMonotonic(points)
  const {
    points: bridgedPoints,
    inserted: flightPointsInserted,
    flightRanges,
  } = bridgeFlights(normPoints, opts)

  if (bridgedPoints.length === 0) {
    return { trips: [], duplicateTimeFixed, flightPointsInserted }
  }

  const segments: Array<[number, number]> = []
  let segStart = 0
  for (let i = 1; i < bridgedPoints.length; i++) {
    const gap = bridgedPoints[i].t - bridgedPoints[i - 1].t
    if (gap > gapSec) {
      segments.push([segStart, i - 1])
      segStart = i
    }
  }
  segments.push([segStart, bridgedPoints.length - 1])

  const trips: Trip[] = segments.map(([s, e]) => {
    const count = e - s + 1
    const coords = new Float64Array(count * 2)
    const times = new Int32Array(count)
    for (let k = 0; k < count; k++) {
      const p = bridgedPoints[s + k]
      coords[k * 2] = p.lon
      coords[k * 2 + 1] = p.lat
      times[k] = p.t
    }

    const isFlight = flightRanges.some(([fs, fe]) => s <= fe && e >= fs)
    const mode: TravelMode = isFlight ? 'FLYING' : 'UNKNOWN'

    const trip: Trip = {
      coords,
      times,
      tStart: bridgedPoints[s].t,
      tEnd: bridgedPoints[e].t,
      mode,
      isFlight,
    }
    return trip
  })

  return { trips, duplicateTimeFixed, flightPointsInserted }
}

/** 各トリップに、時間で重なる Google の activity セグメント（Move）のうち
 *  重なりが最大のものの mode を割り当てる。既に 'FLYING' のトリップはそのまま。
 *  何とも重ならない場合は元の mode を維持する。既存の Trip は変更せず、新しい
 *  Trip オブジェクトを返す。 */
export function assignModes(trips: Trip[], moves: Move[]): Trip[] {
  return trips.map((trip) => {
    if (trip.mode === 'FLYING') {
      return { ...trip }
    }

    let bestMode: TravelMode = trip.mode
    let bestOverlap = 0
    for (const mv of moves) {
      const overlap = Math.min(trip.tEnd, mv.end) - Math.max(trip.tStart, mv.start)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestMode = mv.mode
      }
    }

    return { ...trip, mode: bestMode }
  })
}
