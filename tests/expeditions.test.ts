import { describe, expect, it } from 'vitest'
import { bearingDeg, collectPresences, compassJa, type PresenceSource } from '../src/core/barycenter'
import { findExpeditions } from '../src/core/expeditions'
import { haversineMeters } from '../src/core/geo'
import { buildTrips } from '../src/core/trips'
import type { Seconds, TrackPoint, Trip } from '../src/core/types'

/** 座標はすべて架空（DESIGN.md §9） */

const JST = 540
const H = 3600

/** 記録側 TZ での暦日の 0 時（絶対秒） */
function midnight(y: number, m: number, d: number, tz = JST): number {
  return Date.UTC(y, m - 1, d) / 1000 - tz * 60
}

/**
 * center の周りを 10 分おきに回る点列。半径を 3 段で変えるのは、
 * 完全な等間隔の点列が大圏補間と見分けられなくならないようにするため。
 */
function around(t0: number, hours: number, lat: number, lon: number, spreadKm = 1.5): TrackPoint[] {
  const pts: TrackPoint[] = []
  const n = Math.floor(hours * 6)
  const kmPerLon = 111.32 * Math.cos((lat * Math.PI) / 180)
  for (let k = 0; k < n; k++) {
    const r = (spreadKm * ((k % 3) + 1)) / 3
    const a = (k * 30 * Math.PI) / 180
    pts.push({ t: t0 + k * 600, lat: lat + (r * Math.cos(a)) / 110.574, lon: lon + (r * Math.sin(a)) / kmPerLon })
  }
  return pts
}

function toTrip(pts: TrackPoint[]): Trip {
  const coords = new Float64Array(pts.length * 2)
  const times = new Int32Array(pts.length)
  pts.forEach((p, i) => {
    coords[i * 2] = p.lon
    coords[i * 2 + 1] = p.lat
    times[i] = p.t
  })
  return { coords, times, tStart: times[0]!, tEnd: times[pts.length - 1]!, mode: 'UNKNOWN', isFlight: false }
}

const HOME = { lat: 35.0, lon: 139.0 }

/** HOME から真北へ distKm の地点 */
function north(distKm: number): { lat: number; lon: number } {
  return { lat: HOME.lat + distKm / 110.574, lon: HOME.lon }
}

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  haversineMeters(a.lat, a.lon, b.lat, b.lon) / 1000

/**
 * 2023 年 5 月の 1 か月。places に書いた日はそこに居て、書いていない日は家に居る。
 * null の日は記録そのものが無い。
 */
function may(places: Record<number, { lat: number; lon: number } | null>, tz = JST): PresenceSource {
  const trips: Trip[] = []
  for (let d = 1; d <= 31; d++) {
    const at = d in places ? places[d] : HOME
    if (!at) continue
    trips.push(toTrip(around(midnight(2023, 5, d) + 8 * H, 12, at.lat, at.lon)))
  }
  return { trips, tzChanges: [[0, tz]] }
}

describe('findExpeditions', () => {
  it('連続した遠出の日は 1 件にまとまる', () => {
    const far = north(200)
    const ex = findExpeditions(may({ 11: far, 12: far, 13: far }))
    expect(ex).toHaveLength(1)
    const e = ex[0]!
    expect(e.startDay).toBe('2023-05-11')
    expect(e.endDay).toBe('2023-05-13')
    expect(e.days).toBe(3)
    expect(e.start).toBe(midnight(2023, 5, 11))
    expect(e.end).toBe(midnight(2023, 5, 14))
    expect(e.maxKm).toBeGreaterThan(195)
    expect(e.maxKm).toBeLessThan(205)
    expect(e.hasFlight).toBe(false)
    expect(compassJa(bearingDeg(e.home, e.farthest))).toBe('北')
    // 範囲は行き先を囲み、自宅は含めない
    const [w, s, east, n] = e.bbox
    expect(s).toBeLessThanOrEqual(e.farthest.lat)
    expect(n).toBeGreaterThanOrEqual(e.farthest.lat)
    expect(w).toBeLessThanOrEqual(e.farthest.lon)
    expect(east).toBeGreaterThanOrEqual(e.farthest.lon)
    expect(s).toBeGreaterThan(HOME.lat + 1)
  })

  it('家に戻った日があれば別の遠征に分かれる（新しい順）', () => {
    const far = north(200)
    const ex = findExpeditions(may({ 11: far, 12: far, 14: far, 15: far }))
    expect(ex.map((e) => [e.startDay, e.endDay])).toEqual([
      ['2023-05-14', '2023-05-15'],
      ['2023-05-11', '2023-05-12'],
    ])
  })

  it('1 日だけの空白は、家の近くに居なければつなぐ', () => {
    const far = north(200)
    // 13 日は記録が無い
    const noData = findExpeditions(may({ 11: far, 12: far, 13: null, 14: far }))
    expect(noData.map((e) => [e.startDay, e.endDay, e.days])).toEqual([['2023-05-11', '2023-05-14', 4]])

    // 13 日は家から 30km（しきい値 50km 未満だが家には戻っていない）
    const nearby = findExpeditions(may({ 11: far, 12: far, 13: north(30), 14: far }))
    expect(nearby.map((e) => [e.startDay, e.endDay])).toEqual([['2023-05-11', '2023-05-14']])

    // 2 日空いたら戻っていたか分からないので切る
    const twoDays = findExpeditions(may({ 11: far, 12: null, 13: null, 14: far }))
    expect(twoDays).toHaveLength(2)
  })

  it('しきい値を超えた日だけを遠出とする', () => {
    const src = may({ 20: north(80) })
    expect(findExpeditions(src)).toHaveLength(1) // 既定 50km
    expect(findExpeditions(src, { minKm: 50 })[0]!.days).toBe(1)
    expect(findExpeditions(src, { minKm: 100 })).toHaveLength(0)
  })

  it('記録側 TZ（+540）の暦日で日を切る', () => {
    const far = north(200)
    // 5/2 の 0:30〜1:30（JST）だけ遠くに居た。UTC では 5/1 の 15:30
    const src = may({})
    src.trips.push(toTrip(around(midnight(2023, 5, 2) + 0.5 * H, 1, far.lat, far.lon)))

    const [jst] = findExpeditions(src)
    expect(jst!.startDay).toBe('2023-05-02')
    expect(jst!.start).toBe(midnight(2023, 5, 2))
    expect(jst!.end).toBe(midnight(2023, 5, 3))

    // 同じ点を UTC で数えると前の日になる（TZ を無視すると海外滞在や深夜の移動がずれる）
    const [utc] = findExpeditions({ trips: src.trips, tzChanges: [[0, 0]] })
    expect(utc!.startDay).toBe('2023-05-01')
    expect(utc!.start).toBe(midnight(2023, 5, 1, 0))
  })

  it('大圏補間の点は遠出に数えない。出発日ではなく到着日から始まり、飛行機の印が付く', () => {
    const FAR = { lat: 35.0, lon: 169.0 }
    const DEST_TZ = 660
    const tArrive: Seconds = midnight(2023, 5, 22) + 2 * H // JST 2:00 着（現地 4:00）
    const tReturn: Seconds = midnight(2023, 5, 25) + 16 * H // JST 16:00 帰着
    const pts: TrackPoint[] = []
    for (let d = 1; d <= 21; d++) pts.push(...around(midnight(2023, 5, d) + 8 * H, 12, HOME.lat, HOME.lon))
    // 5/21 20:00 JST に出発、6 時間後に 2,700km 先へ着く夜行便
    pts.push(...around(tArrive, 17, FAR.lat, FAR.lon))
    for (let d = 23; d <= 24; d++) pts.push(...around(midnight(2023, 5, d, DEST_TZ) + 8 * H, 12, FAR.lat, FAR.lon))
    pts.push(...around(midnight(2023, 5, 25, DEST_TZ) + 8 * H, 2, FAR.lat, FAR.lon))
    pts.push(...around(tReturn, 4, HOME.lat, HOME.lon))
    for (let d = 26; d <= 31; d++) pts.push(...around(midnight(2023, 5, d) + 8 * H, 12, HOME.lat, HOME.lon))

    const { trips } = buildTrips(pts)
    expect(trips.some((t) => t.isFlight)).toBe(true)
    const src: PresenceSource = {
      trips,
      tzChanges: [
        [0, JST],
        [tArrive, DEST_TZ],
        [tReturn, JST],
      ],
    }

    const p = collectPresences(src)
    for (let i = 0; i < p.count; i++) {
      const at = { lat: p.lat[i]!, lon: p.lon[i]! }
      expect(Math.min(km(at, HOME), km(at, FAR))).toBeLessThan(5)
    }

    const ex = findExpeditions(src)
    expect(ex).toHaveLength(1)
    const e = ex[0]!
    // 5/21 は出発しただけ（上空の補間点を数えると 5/21 から始まってしまう）
    expect(e.startDay).toBe('2023-05-22')
    expect(e.endDay).toBe('2023-05-25')
    expect(e.hasFlight).toBe(true)
    // 始まりは到着地の TZ、終わりは帰着後の TZ で暦日を戻す
    expect(e.start).toBe(midnight(2023, 5, 22, DEST_TZ))
    expect(e.end).toBe(midnight(2023, 5, 26, JST))
    expect(e.maxKm).toBeGreaterThan(2600)
    expect(compassJa(bearingDeg(e.home, e.farthest))).toBe('東')
  })

  it('記録が長く途切れた遅い長距離移動でも、補間点を在圏にしない', () => {
    const FAR = north(250)
    const pts = [
      ...around(midnight(2023, 5, 1) + 8 * H, 2, HOME.lat, HOME.lon),
      // 46 時間後に 250km 先。補間点の間隔は 1km を切るので 2km 基準だけでは見分けられない
      ...around(midnight(2023, 5, 3) + 8 * H, 2, FAR.lat, FAR.lon),
    ]
    const { trips } = buildTrips(pts)
    const flight = trips.find((t) => t.isFlight)!
    let maxSeg = 0
    for (let i = 1; i < flight.times.length; i++) {
      const d = haversineMeters(
        flight.coords[i * 2 - 1]!,
        flight.coords[i * 2 - 2]!,
        flight.coords[i * 2 + 1]!,
        flight.coords[i * 2]!,
      )
      maxSeg = Math.max(maxSeg, d)
    }
    expect(maxSeg).toBeLessThan(2000)

    const p = collectPresences({ trips, tzChanges: [[0, JST]] })
    for (let i = 0; i < p.count; i++) {
      const at = { lat: p.lat[i]!, lon: p.lon[i]! }
      expect(Math.min(km(at, HOME), km(at, FAR))).toBeLessThan(5)
    }
    // 5/2 は丸 1 日上空（補間の中）なので在圏が無い
    expect(p.flightDays.size).toBeGreaterThan(0)
  })

  it('日付変更線をまたぐ行き先でも範囲が地球を一周しない', () => {
    const src = may({})
    const t0 = midnight(2023, 5, 20) + 8 * H
    src.trips.push(
      toTrip([
        { t: t0, lat: -17.0, lon: 179.6 },
        { t: t0 + 600, lat: -17.1, lon: 179.9 },
        { t: t0 + 1200, lat: -17.2, lon: -179.8 },
      ]),
    )
    const [e] = findExpeditions(src)
    const [w, , east] = e!.bbox
    expect(east - w).toBeGreaterThan(0)
    expect(east - w).toBeLessThan(2)
  })
})
