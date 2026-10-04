import { describe, expect, it } from 'vitest'
import { bridgeFlights, buildTrips, MAX_FLIGHT_POINTS_PER_PAIR, MAX_FLIGHT_POINTS_TOTAL } from '../src/core/trips'
import { buildDataset } from '../src/core/pipeline'
import { createSegmentCollector } from '../src/core/segments'
import { PIPELINE_VERSION } from '../src/core/types'
import type { TrackPoint } from '../src/core/types'

const DAY = 86400
const sparse: TrackPoint[] = [{ t: 1_700_000_000, lat: 35, lon: 139 },
  { t: 1_700_000_000 + 90 * DAY, lat: 51, lon: 0 }]

describe('bounded flight interpolation', () => {
  it('bounds the 90-day sparse-gap regression at the supported one-minute threshold', () => {
    const collected = createSegmentCollector().result()
    collected.points = sparse.map(p => ({ ...p }))
    const before = JSON.stringify(collected.points)
    const dataset = buildDataset({ collected, fileHash: 'synthetic', fileName: 'synthetic',
      parsedAt: 0, rawSignalsDiscarded: 0, tripGapSec: 60 })
    expect(dataset.stats.flightPointsInserted).toBe(MAX_FLIGHT_POINTS_PER_PAIR)
    expect(dataset.trips).toHaveLength(1)
    expect(dataset.trips[0]!.isFlight).toBe(true)
    expect(dataset.trips[0]!.tStart).toBe(sparse[0]!.t)
    expect(dataset.trips[0]!.tEnd).toBe(sparse[1]!.t)
    expect(JSON.stringify(collected.points)).toBe(before)
  })
  it('keeps flight density independent of the user split threshold', () => {
    const results = [60, 600, 1800, 86400].map(gapSec => buildTrips(sparse, { gapSec }))
    for (const result of results) {
      expect(result.flightPointsInserted).toBe(MAX_FLIGHT_POINTS_PER_PAIR)
      expect(result.trips).toHaveLength(1)
      const times = result.trips[0]!.times
      for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!)
    }
    expect(results[0]!.trips[0]!.coords).toEqual(results[3]!.trips[0]!.coords)
    expect(results[0]!.trips[0]!.times).toEqual(results[3]!.trips[0]!.times)
  })
  it('does not couple pipeline density to the threshold for an uncapped 13-hour flight', () => {
    const datasets = [60, 1800].map(tripGapSec => {
      const collected = createSegmentCollector().result()
      collected.points = [{ ...sparse[0]! }, { ...sparse[1]!, t: sparse[0]!.t + 13 * 3600 }]
      return buildDataset({ collected, fileHash: 'synthetic', fileName: 'synthetic',
        parsedAt: 0, rawSignalsDiscarded: 0, tripGapSec })
    })
    expect(datasets.map(d => d.stats.flightPointsInserted)).toEqual([77, 77])
    expect(datasets[0]!.trips).toEqual(datasets[1]!.trips)
  })
  it('splits ordinary gaps on both sides of a capped flight and does not mark them as flights', () => {
    const first = sparse[0]!
    const last = sparse[1]!
    const points = [
      { ...first, t: first.t - 120, lon: first.lon - .001 },
      first, last,
      { ...last, t: last.t + 120, lon: last.lon + .001 },
    ]
    const result = buildTrips(points, { gapSec: 60 })
    expect(result.trips.map(t => t.isFlight)).toEqual([false, true, false])
    expect(result.trips.map(t => t.times.length)).toEqual([1, MAX_FLIGHT_POINTS_PER_PAIR + 2, 1])
    expect(points).toHaveLength(4)
  })
  it('caps a direct caller even with a tiny positive interpolation interval', () => {
    expect(bridgeFlights(sparse, { flightMaxSubGapSec: .000001 }).inserted).toBe(MAX_FLIGHT_POINTS_PER_PAIR)
    for (const invalid of [0, -1, NaN, Infinity]) {
      expect(() => bridgeFlights(sparse, { flightMaxSubGapSec: invalid })).toThrow(RangeError)
    }
  })
  it('enforces a whole-import budget before producing a partial dataset', () => {
    const pairCount = Math.floor(MAX_FLIGHT_POINTS_TOTAL / MAX_FLIGHT_POINTS_PER_PAIR) + 1
    const points = Array.from({ length: pairCount + 1 }, (_, i) =>
      Object.freeze({ t: i * 90 * DAY, lat: 35, lon: i % 2 ? 0 : 139 }))
    const original = JSON.stringify(points)
    expect(() => bridgeFlights(points)).toThrow(/100,000/)
    expect(JSON.stringify(points)).toBe(original)
  })
  it('accepts the exact total budget and preserves every observed endpoint', () => {
    const fullPairs = Math.floor(MAX_FLIGHT_POINTS_TOTAL / MAX_FLIGHT_POINTS_PER_PAIR)
    const points = Array.from({ length: fullPairs + 1 }, (_, i) =>
      ({ t: i * 90 * DAY, lat: 35, lon: i % 2 ? 0 : 139 }))
    const remaining = MAX_FLIGHT_POINTS_TOTAL - fullPairs * MAX_FLIGHT_POINTS_PER_PAIR
    points.push({ t: points[points.length - 1]!.t + (remaining + 1) * 600,
      lat: 35, lon: points[points.length - 1]!.lon === 0 ? 139 : 0 })
    const result = bridgeFlights(points)
    expect(result.inserted).toBe(MAX_FLIGHT_POINTS_TOTAL)
    expect(result.points).toHaveLength(points.length + MAX_FLIGHT_POINTS_TOTAL)
    const observed = new Set(result.points)
    for (const point of points) expect(observed.has(point)).toBe(true)
  })
  it('invalidates previously generated oversized cache entries', () => {
    expect(PIPELINE_VERSION).toBeGreaterThan(3)
  })

})
