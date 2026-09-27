import { describe, expect, it } from 'vitest'
import {
  bearingDeg,
  collectPresences,
  compassJa,
  yearlyBarycenters,
  type PresenceSource,
} from '../src/core/barycenter'
import { haversineMeters } from '../src/core/geo'
import { buildTrips } from '../src/core/trips'
import type { TrackPoint, Trip } from '../src/core/types'
import { hsl } from '../src/playback/colors'
import { buildBarycenterLayers, yearColor } from '../src/views/barycenterLayers'

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
 * 向かい合う点の半径が揃うので、点の平均はちょうど center になる。
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

/** y 年 m 月 d 日から days 日間、毎日 8〜20 時に center の周りに居た */
function stayDays(y: number, m: number, d: number, days: number, lat: number, lon: number): Trip[] {
  const out: Trip[] = []
  for (let i = 0; i < days; i++) out.push(toTrip(around(midnight(y, m, d + i) + 8 * H, 12, lat, lon)))
  return out
}

function source(trips: Trip[]): PresenceSource {
  return { trips, tzChanges: [[0, JST]] }
}

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  haversineMeters(a.lat, a.lon, b.lat, b.lon) / 1000

const HOME = { lat: 35.0, lon: 139.0 }

describe('collectPresences', () => {
  it('同じ日に同じ格子で何点記録されても在圏は 1 件', () => {
    const t0 = midnight(2022, 3, 1) + 8 * H
    const pts: TrackPoint[] = []
    for (let k = 0; k < 30; k++) pts.push({ t: t0 + k * 600, lat: HOME.lat, lon: HOME.lon })
    // 翌日も同じ場所。日が違うので別の在圏になる
    for (let k = 0; k < 30; k++) pts.push({ t: t0 + 86400 + k * 600, lat: HOME.lat, lon: HOME.lon })
    const p = collectPresences(source([toTrip(pts)]))
    expect(p.count).toBe(2)
    expect(p.day[1]! - p.day[0]!).toBe(1)
  })
})

describe('yearlyBarycenters', () => {
  it('1 か所で暮らした年は、重心がその近くに来て行動半径が小さい', () => {
    const stats = yearlyBarycenters(source(stayDays(2022, 3, 1, 60, HOME.lat, HOME.lon)))
    expect(stats).toHaveLength(1)
    const s = stats[0]!
    expect(s.year).toBe(2022)
    expect(s.days).toBe(60)
    expect(km(s, HOME)).toBeLessThan(1)
    expect(s.radiusKm).toBeLessThan(2)
    expect(s.awayShare).toBe(0)
    expect(s.shiftKm).toBeNull()
    expect(km(s.homeCell, HOME)).toBeLessThan(1.5)
  })

  it('遠くへの旅行は重心を引きずらず、遠出の割合として出る', () => {
    const FAR = { lat: 48.0, lon: 11.0 }
    const trips = [
      ...stayDays(2022, 3, 1, 60, HOME.lat, HOME.lon),
      ...stayDays(2022, 6, 1, 5, FAR.lat, FAR.lon),
    ]
    const [s] = yearlyBarycenters(source(trips))

    // 素朴な平均なら数百 km 西へずれる（比較のため）
    const p = collectPresences(source(trips))
    let lat = 0
    let lon = 0
    for (let i = 0; i < p.count; i++) {
      lat += p.lat[i]!
      lon += p.lon[i]!
    }
    expect(km({ lat: lat / p.count, lon: lon / p.count }, HOME)).toBeGreaterThan(300)

    expect(km(s!, HOME)).toBeLessThan(1)
    expect(s!.radiusKm).toBeLessThan(2)
    expect(s!.days).toBe(65)
    expect(s!.awayShare).toBeGreaterThan(0)
    expect(s!.awayShare).toBeLessThan(0.2)
  })

  it('引っ越すと翌年の重心が移り、移動距離が出る', () => {
    const MOVED = { lat: 35.3, lon: 139.4 }
    const stats = yearlyBarycenters(
      source([
        ...stayDays(2021, 3, 1, 60, HOME.lat, HOME.lon),
        ...stayDays(2022, 3, 1, 60, MOVED.lat, MOVED.lon),
      ]),
    )
    expect(stats.map((s) => s.year)).toEqual([2021, 2022])
    expect(km(stats[0]!, HOME)).toBeLessThan(1)
    expect(km(stats[1]!, MOVED)).toBeLessThan(1)
    expect(stats[1]!.shiftKm!).toBeCloseTo(km(HOME, MOVED), 0)
    expect(compassJa(bearingDeg(stats[0]!, stats[1]!))).toBe('北東')
  })

  it('大圏補間の点は在圏に入らない', () => {
    const FAR = { lat: 35.0, lon: 169.0 }
    const pts = [
      ...around(midnight(2022, 5, 1) + 8 * H, 12, HOME.lat, HOME.lon),
      // 6 時間後に 2,700km 先。trips.ts が大圏コースで補間する
      ...around(midnight(2022, 5, 2) + 2 * H, 12, FAR.lat, FAR.lon),
    ]
    const { trips } = buildTrips(pts)
    expect(trips.some((t) => t.isFlight)).toBe(true)
    const p = collectPresences(source(trips))
    for (let i = 0; i < p.count; i++) {
      const at = { lat: p.lat[i]!, lon: p.lon[i]! }
      expect(Math.min(km(at, HOME), km(at, FAR))).toBeLessThan(5)
    }
  })
})

describe('buildBarycenterLayers', () => {
  it('レイヤ id は barycenter- で始まり重複しない', () => {
    const stats = yearlyBarycenters(
      source([
        ...stayDays(2021, 3, 1, 10, HOME.lat, HOME.lon),
        ...stayDays(2022, 3, 1, 10, 35.3, 139.4),
      ]),
    )
    const ids = buildBarycenterLayers(stats, { minYear: 2019, maxYear: 2026, selectedYear: 2022 }).map(
      (l) => l.id,
    )
    expect(ids).toContain('barycenter-path')
    expect(ids.every((id) => id.startsWith('barycenter-'))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect(buildBarycenterLayers([], { minYear: 2019, maxYear: 2026 })).toEqual([])
  })

  it('年の色は再生の「年別」と同じ色相環', () => {
    expect(yearColor(2022, 2019, 2026)).toEqual(hsl(((2022 - 2019) / 7) * 280, 0.75, 0.58))
    // 範囲外の年は端に寄せる
    expect(yearColor(2017, 2019, 2026)).toEqual(yearColor(2019, 2019, 2026))
  })
})
