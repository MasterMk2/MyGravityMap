import { describe, it, expect } from 'vitest'
import type { TrackPoint, Move } from '../src/core/types'
import { normalizeMonotonic, bridgeFlights, buildTrips, assignModes } from '../src/core/trips'

// Tokyo and Paris, ~9716 km apart great-circle. Used to synthesize a long-haul flight leg.
const TOKYO: [number, number] = [35.6812, 139.7671]
const PARIS: [number, number] = [48.8566, 2.3522]
const THIRTEEN_HOURS = 13 * 3600

describe('normalizeMonotonic', () => {
  it('sorts by t and is strictly increasing', () => {
    const points: TrackPoint[] = [
      { t: 300, lat: 6, lon: 6 },
      { t: 100, lat: 1, lon: 1 },
      { t: 200, lat: 5, lon: 5 },
    ]
    const { points: out } = normalizeMonotonic(points)
    expect(out.map((p) => p.t)).toEqual([100, 200, 300])
  })

  it('keeps only the last point among same-t points that differ in position, and counts the drops', () => {
    const points: TrackPoint[] = [
      { t: 100, lat: 1, lon: 1 },
      { t: 100, lat: 2, lon: 2 },
      { t: 100, lat: 3, lon: 3 },
    ]
    const { points: out, duplicateTimeFixed } = normalizeMonotonic(points)
    expect(out).toEqual([{ t: 100, lat: 3, lon: 3 }])
    expect(duplicateTimeFixed).toBe(2)
  })

  it('removes exact duplicates (same t and same lat/lon) without counting them', () => {
    const points: TrackPoint[] = [
      { t: 50, lat: 9, lon: 9 },
      { t: 50, lat: 9, lon: 9 },
    ]
    const { points: out, duplicateTimeFixed } = normalizeMonotonic(points)
    expect(out).toEqual([{ t: 50, lat: 9, lon: 9 }])
    expect(duplicateTimeFixed).toBe(0)
  })
})

describe('bridgeFlights', () => {
  it('bridges a 9000+ km / 13 hour pair with intermediate points, no sub-gap over 600s', () => {
    const points: TrackPoint[] = [
      { t: 0, lat: TOKYO[0], lon: TOKYO[1] },
      { t: THIRTEEN_HOURS, lat: PARIS[0], lon: PARIS[1] },
    ]
    const { points: out, inserted, flightRanges } = bridgeFlights(points)
    expect(inserted).toBeGreaterThan(0)
    expect(out.length).toBe(2 + inserted)
    expect(flightRanges).toEqual([[0, out.length - 1]])

    for (let i = 1; i < out.length; i++) {
      const gap = out[i].t - out[i - 1].t
      expect(gap).toBeLessThanOrEqual(600)
      expect(gap).toBeGreaterThan(0)
    }
    // times strictly increase and endpoints are preserved
    expect(out[0]).toEqual(points[0])
    expect(out[out.length - 1]).toEqual(points[1])
  })

  it('does not bridge a short, slow pair', () => {
    const points: TrackPoint[] = [
      { t: 0, lat: 35.68, lon: 139.76 },
      { t: 600, lat: 35.681, lon: 139.761 },
    ]
    const { inserted, flightRanges } = bridgeFlights(points)
    expect(inserted).toBe(0)
    expect(flightRanges).toEqual([])
  })

  it('keeps times strictly increasing even for a short-duration flight (the "at least 8 points" floor could otherwise pack sub-second gaps that round to duplicates)', () => {
    const points: TrackPoint[] = [
      { t: 0, lat: 0, lon: 0 },
      { t: 5, lat: 0, lon: 2 }, // ~222 km in 5s -> qualifies as a flight
    ]
    const { points: out, inserted } = bridgeFlights(points)
    expect(inserted).toBeGreaterThan(0)
    for (let i = 1; i < out.length; i++) {
      expect(out[i].t).toBeGreaterThan(out[i - 1].t)
    }
    expect(out[out.length - 1].t).toBe(5)
  })
})

describe('buildTrips', () => {
  it('keeps a long-haul flight leg as a single isFlight trip, but splits an ordinary 2h gap', () => {
    const points: TrackPoint[] = [
      { t: 0, lat: TOKYO[0], lon: TOKYO[1] },
      { t: 600, lat: TOKYO[0] + 0.001, lon: TOKYO[1] + 0.001 },
      { t: 1200, lat: TOKYO[0] + 0.002, lon: TOKYO[1] + 0.002 },
      { t: 1200 + THIRTEEN_HOURS, lat: PARIS[0], lon: PARIS[1] },
      { t: 1200 + THIRTEEN_HOURS + 600, lat: PARIS[0] + 0.001, lon: PARIS[1] + 0.001 },
      { t: 1200 + THIRTEEN_HOURS + 1200, lat: PARIS[0] + 0.002, lon: PARIS[1] + 0.002 },
      // ordinary 2h stationary gap, short distance -> must split into a new trip
      { t: 1200 + THIRTEEN_HOURS + 1200 + 7200, lat: PARIS[0] + 0.003, lon: PARIS[1] + 0.003 },
    ]

    const { trips, flightPointsInserted, duplicateTimeFixed } = buildTrips(points)

    expect(duplicateTimeFixed).toBe(0)
    expect(flightPointsInserted).toBeGreaterThan(0)
    expect(trips).toHaveLength(2)

    const [flightTrip, afterGapTrip] = trips
    expect(flightTrip.isFlight).toBe(true)
    expect(flightTrip.mode).toBe('FLYING')
    // the flight leg itself was not split: it's inside the first trip
    expect(flightTrip.tStart).toBe(0)
    expect(flightTrip.tEnd).toBe(1200 + THIRTEEN_HOURS + 1200)

    expect(afterGapTrip.isFlight).toBe(false)
    expect(afterGapTrip.mode).toBe('UNKNOWN')
    // single-point trip is kept
    expect(afterGapTrip.times.length).toBe(1)

    // times must be strictly increasing through the bridged flight leg too, not just
    // in the un-bridged parts of the trip.
    for (let i = 1; i < flightTrip.times.length; i++) {
      expect(flightTrip.times[i]).toBeGreaterThan(flightTrip.times[i - 1])
    }
  })

  it('splits an ordinary >30min stationary gap into two trips even without a flight', () => {
    const points: TrackPoint[] = [
      { t: 0, lat: 35.68, lon: 139.76 },
      { t: 600, lat: 35.681, lon: 139.761 },
      { t: 600 + 7200, lat: 35.682, lon: 139.762 }, // 2h gap, short distance
    ]
    const { trips } = buildTrips(points)
    expect(trips).toHaveLength(2)
    expect(trips[0].isFlight).toBe(false)
    expect(trips[1].isFlight).toBe(false)
  })

  it('produces coords as [lon, lat, ...] pairs and strictly increasing times within each trip', () => {
    // Small steps (~11m per 10s, ~4 km/h) so this is nowhere near the flight thresholds.
    const points: TrackPoint[] = [
      { t: 0, lat: 10, lon: 20 },
      { t: 10, lat: 10.0001, lon: 20.0001 },
      { t: 20, lat: 10.0002, lon: 20.0002 },
    ]
    const { trips } = buildTrips(points)
    expect(trips).toHaveLength(1)
    const trip = trips[0]
    expect(Array.from(trip.coords)).toEqual([20, 10, 20.0001, 10.0001, 20.0002, 10.0002])
    expect(Array.from(trip.times)).toEqual([0, 10, 20])
    for (let i = 1; i < trip.times.length; i++) {
      expect(trip.times[i]).toBeGreaterThan(trip.times[i - 1])
    }
  })

  it('keeps single-point trips (isolated points surrounded by big gaps)', () => {
    const points: TrackPoint[] = [
      { t: 0, lat: 10, lon: 20 },
      { t: 10000, lat: 11, lon: 21 },
      { t: 20000, lat: 12, lon: 22 },
    ]
    const { trips } = buildTrips(points)
    expect(trips).toHaveLength(3)
    for (const trip of trips) {
      expect(trip.times.length).toBe(1)
      expect(trip.coords.length).toBe(2)
    }
  })
})

describe('assignModes', () => {
  const baseMove: Omit<Move, 'start' | 'end' | 'mode'> = {
    tzOffsetMin: 540,
    from: [139.76, 35.68],
    to: [139.77, 35.69],
    distanceMeters: 5000,
    probability: 0.9,
  }

  it('picks the mode with the largest time overlap', () => {
    // Consecutive gaps of exactly 1800s (the default gapSec) do not split, so this
    // stays one trip spanning t=0..3600 even though it's split into 3 raw points.
    const points: TrackPoint[] = [
      { t: 0, lat: 35.68, lon: 139.76 },
      { t: 1800, lat: 35.685, lon: 139.765 },
      { t: 3600, lat: 35.69, lon: 139.77 },
    ]
    const { trips } = buildTrips(points)
    expect(trips).toHaveLength(1)

    const moves: Move[] = [
      { ...baseMove, start: 0, end: 600, mode: 'WALKING' }, // 10 min overlap
      { ...baseMove, start: 600, end: 2400, mode: 'IN_PASSENGER_VEHICLE' }, // 30 min overlap
    ]

    const [result] = assignModes(trips, moves)
    expect(result.mode).toBe('IN_PASSENGER_VEHICLE')
  })

  it('leaves FLYING trips as FLYING regardless of overlapping moves', () => {
    const points: TrackPoint[] = [
      { t: 0, lat: TOKYO[0], lon: TOKYO[1] },
      { t: THIRTEEN_HOURS, lat: PARIS[0], lon: PARIS[1] },
    ]
    const { trips } = buildTrips(points)
    expect(trips[0].isFlight).toBe(true)

    const moves: Move[] = [{ ...baseMove, start: 0, end: THIRTEEN_HOURS, mode: 'WALKING' }]
    const [result] = assignModes(trips, moves)
    expect(result.mode).toBe('FLYING')
  })

  it('bridges a long-distance jump even when the implied speed looks slow', () => {
    // 実データの沖縄往復に相当するケース。機内と前後で記録が飛んでいるため
    // 1,390km を 51 時間かけて移動したように見え、速度は 27km/h しかない。
    // 速度条件だけだと取りこぼして線が途切れる。
    const FIFTY_ONE_HOURS = 51 * 3600
    const points: TrackPoint[] = [
      { t: 0, lat: 36.5, lon: 136.6 },
      { t: FIFTY_ONE_HOURS, lat: 26.5, lon: 127.9 },
      { t: FIFTY_ONE_HOURS + 600, lat: 26.51, lon: 127.91 },
    ]
    const { trips } = buildTrips(points)
    expect(trips).toHaveLength(1)
    expect(trips[0].isFlight).toBe(true)
  })

  it('leaves a moderate jump with a long unrecorded gap split', () => {
    // 「44 時間空いて 129km」— 間に何をしたか分からないので、繋ぐと嘘になる。
    const FORTY_FOUR_HOURS = 44 * 3600
    const points: TrackPoint[] = [
      { t: 0, lat: 35.4, lon: 136.0 },
      { t: FORTY_FOUR_HOURS, lat: 36.5, lon: 136.6 },
    ]
    const { trips } = buildTrips(points)
    expect(trips).toHaveLength(2)
    expect(trips.every((t) => !t.isFlight)).toBe(true)
  })

  it('does not mutate the input trips', () => {
    const points: TrackPoint[] = [
      { t: 0, lat: 35.68, lon: 139.76 },
      { t: 1800, lat: 35.685, lon: 139.765 },
      { t: 3600, lat: 35.69, lon: 139.77 },
    ]
    const { trips } = buildTrips(points)
    const moves: Move[] = [{ ...baseMove, start: 0, end: 3600, mode: 'CYCLING' }]
    assignModes(trips, moves)
    expect(trips[0].mode).toBe('UNKNOWN')
  })
})
