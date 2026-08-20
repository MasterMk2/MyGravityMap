import type { Trip } from '../core/types'

export interface Cursor {
  lon: number
  lat: number
  /** 移動中か（false なら記録が途切れている／滞在中で、最後に居た場所を指している） */
  moving: boolean
}

/**
 * 再生ヘッドの現在位置を求める。
 *
 * トリップは時刻昇順で互いに重ならない（同じ点列を切って作るため）ので、
 * 「開始が currentRel 以下である最後のトリップ」を二分探索すれば足りる。
 * そのトリップの中にいれば線形補間、既に終わっていれば最後の点に留まる。
 * 止まっている間もマーカーを消さないための挙動。
 */
export function positionAt(
  trips: Trip[],
  rel: Float32Array[],
  currentRel: number,
): Cursor | undefined {
  if (trips.length === 0) return undefined

  let lo = 0
  let hi = trips.length - 1
  if ((rel[0]?.[0] ?? Infinity) > currentRel) return undefined
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((rel[mid]?.[0] ?? Infinity) <= currentRel) lo = mid
    else hi = mid - 1
  }

  const trip = trips[lo]
  const times = rel[lo]
  if (!trip || !times || times.length === 0) return undefined

  const last = times.length - 1
  if (currentRel >= (times[last] ?? 0)) {
    return { lon: trip.coords[last * 2] ?? 0, lat: trip.coords[last * 2 + 1] ?? 0, moving: false }
  }

  // トリップ内の区間を二分探索して線形補間
  let a = 0
  let b = last
  while (a < b) {
    const mid = (a + b + 1) >> 1
    if ((times[mid] ?? 0) <= currentRel) a = mid
    else b = mid - 1
  }
  const t0 = times[a] ?? 0
  const t1 = times[a + 1] ?? t0
  const span = t1 - t0
  const f = span > 0 ? (currentRel - t0) / span : 0
  const lon0 = trip.coords[a * 2] ?? 0
  const lat0 = trip.coords[a * 2 + 1] ?? 0
  const lon1 = trip.coords[(a + 1) * 2] ?? lon0
  const lat1 = trip.coords[(a + 1) * 2 + 1] ?? lat0
  return {
    lon: lon0 + (lon1 - lon0) * f,
    lat: lat0 + (lat1 - lat0) * f,
    moving: true,
  }
}
