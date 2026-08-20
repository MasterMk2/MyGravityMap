import { describe, it, expect } from 'vitest'
import {
  parseLatLng,
  parseTimeSec,
  tzOffsetMinFromIso,
  haversineMeters,
  greatCircleIntermediate,
  localDayKey,
  localHour,
  localWeekday,
} from '../src/core/geo'

describe('parseLatLng', () => {
  it('parses "lat°, lon°" with the degree sign', () => {
    expect(parseLatLng('35.1234567°, 139.7654321°')).toEqual([35.1234567, 139.7654321])
  })

  it('parses negative coordinates', () => {
    expect(parseLatLng('-33.8688°, 151.2093°')).toEqual([-33.8688, 151.2093])
  })

  it('accepts the string without ° and with extra spaces', () => {
    expect(parseLatLng('  35.1234567 ,  139.7654321  ')).toEqual([35.1234567, 139.7654321])
  })

  it('throws on unparseable input', () => {
    expect(() => parseLatLng('not a coordinate')).toThrow()
  })
})

describe('parseTimeSec / tzOffsetMinFromIso', () => {
  it('parses an ISO string with a +09:00 offset to unix seconds', () => {
    expect(parseTimeSec('2024-11-06T18:16:57.000+09:00')).toBe(1730884617)
    expect(tzOffsetMinFromIso('2024-11-06T18:16:57.000+09:00')).toBe(540)
  })

  it('parses a Z (UTC) timestamp', () => {
    expect(parseTimeSec('2024-11-06T09:16:57.000Z')).toBe(1730884617)
    expect(tzOffsetMinFromIso('2024-11-06T09:16:57.000Z')).toBe(0)
  })

  it('returns null when there is no offset info', () => {
    expect(tzOffsetMinFromIso('not a timestamp')).toBeNull()
  })

  it('floors fractional seconds', () => {
    expect(parseTimeSec('2024-11-06T09:16:57.900Z')).toBe(1730884617)
  })
})

describe('haversineMeters', () => {
  it('is ~111.19 km for 1 degree of latitude', () => {
    const d = haversineMeters(0, 0, 1, 0)
    expect(d).toBeGreaterThan(111195 * 0.99)
    expect(d).toBeLessThan(111195 * 1.01)
  })

  it('is 0 for identical points', () => {
    expect(haversineMeters(35.68, 139.76, 35.68, 139.76)).toBe(0)
  })
})

describe('greatCircleIntermediate', () => {
  it('returns [] for n=0', () => {
    expect(greatCircleIntermediate(0, 0, 10, 10, 0)).toEqual([])
  })

  it('returns n points strictly between the endpoints', () => {
    const pts = greatCircleIntermediate(0, 0, 0, 90, 3)
    expect(pts).toHaveLength(3)
    // Along the equator, longitude should increase monotonically from 0 to 90.
    for (const [lat, lon] of pts) {
      expect(lat).toBeCloseTo(0, 6)
      expect(lon).toBeGreaterThan(0)
      expect(lon).toBeLessThan(90)
    }
    expect(pts[0][1]).toBeLessThan(pts[1][1])
    expect(pts[1][1]).toBeLessThan(pts[2][1])
  })
})

describe('localDayKey / localHour / localWeekday', () => {
  // 2025-03-14T23:30:00Z, tzOffsetMin=540 (JST) -> 2025-03-15 08:30 local, a Saturday.
  const tSec = 1741995000
  const tzOffsetMin = 540

  it('computes the local calendar day independent of machine TZ', () => {
    expect(localDayKey(tSec, tzOffsetMin)).toBe('2025-03-15')
  })

  it('computes the local hour', () => {
    expect(localHour(tSec, tzOffsetMin)).toBe(8)
  })

  it('computes the local weekday (0=Sunday)', () => {
    expect(localWeekday(tSec, tzOffsetMin)).toBe(6) // Saturday
  })

  it('handles a negative offset that crosses to the previous day', () => {
    // 2025-03-15T00:30:00Z with tzOffsetMin=-60 -> 2025-03-14 23:30 local.
    const t = Date.UTC(2025, 2, 15, 0, 30, 0) / 1000
    expect(localDayKey(t, -60)).toBe('2025-03-14')
    expect(localHour(t, -60)).toBe(23)
  })
})
