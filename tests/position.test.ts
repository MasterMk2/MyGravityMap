import { describe, expect, it } from 'vitest'
import { positionAt, snapToSample } from '../src/playback/position'
import type { Trip } from '../src/core/types'

function trip(coords: number[], times: number[]): Trip {
  return {
    coords: new Float64Array(coords),
    times: new Int32Array(times),
    tStart: times[0]!,
    tEnd: times[times.length - 1]!,
    mode: 'UNKNOWN',
    isFlight: false,
  }
}

describe('positionAt', () => {
  // [lon, lat] の順であることに注意
  const t1 = trip([139.0, 35.0, 139.0, 36.0], [0, 100])
  const t2 = trip([140.0, 30.0, 141.0, 30.0], [1000, 1100])
  const trips = [t1, t2]
  const rel = [new Float32Array([0, 100]), new Float32Array([1000, 1100])]

  it('interpolates inside a trip', () => {
    const p = positionAt(trips, rel, 50)
    expect(p?.moving).toBe(true)
    expect(p?.lat).toBeCloseTo(35.5, 6)
    expect(p?.lon).toBeCloseTo(139.0, 6)
  })

  it('holds the last point after a trip has ended', () => {
    const p = positionAt(trips, rel, 500)
    expect(p?.moving).toBe(false)
    expect(p?.lat).toBeCloseTo(36.0, 6)
  })

  it('picks the later trip once it has started', () => {
    const p = positionAt(trips, rel, 1050)
    expect(p?.moving).toBe(true)
    expect(p?.lon).toBeCloseTo(140.5, 6)
    expect(p?.lat).toBeCloseTo(30.0, 6)
  })

  it('returns undefined before any trip starts', () => {
    expect(positionAt(trips, rel, -10)).toBeUndefined()
  })

  it('returns undefined with no trips', () => {
    expect(positionAt([], [], 0)).toBeUndefined()
  })

  it('handles a single-point trip', () => {
    const solo = [trip([135.0, 34.0], [0])]
    const soloRel = [new Float32Array([0])]
    const p = positionAt(solo, soloRel, 10)
    expect(p).toEqual({ lon: 135.0, lat: 34.0, moving: false })
  })
})


describe('stepped playback', () => {
  const trips = [trip([10, 30, 12, 32, 14, 34], [0, 10, 20]), trip([20, 40], [100])]
  const rel = [new Float32Array([0, 10, 20]), new Float32Array([100])]
  it('holds the preceding point, advances exactly at samples and supports reverse scrubbing', () => {
    expect(positionAt(trips, rel, 9, 'none')?.lon).toBe(10)
    expect(positionAt(trips, rel, 10, 'none')?.lon).toBe(12)
    expect(positionAt(trips, rel, 19, 'none')?.lon).toBe(12)
    expect(positionAt(trips, rel, 4, 'none')?.lon).toBe(10)
    expect(positionAt(trips, rel, 40, 'none')?.lon).toBe(14)
    expect(positionAt(trips, rel, 100, 'none')?.lon).toBe(20)
    expect(positionAt(trips, rel, -1, 'none')).toBeUndefined()
    expect(positionAt(trips, rel, 5)?.lon).toBe(11)
  })
})


it('snaps trails inside a trip but keeps the real clock in gaps', () => {
  const rel = [Float32Array.from([0, 10, 20]), Float32Array.from([100, 200])]
  expect(snapToSample(rel, 15)).toBe(10)
  expect(snapToSample(rel, 50)).toBe(50)
  expect(snapToSample(rel, 150)).toBe(100)
  expect(snapToSample(rel, -1)).toBe(-1)
  expect(snapToSample([], 1)).toBe(1)
})
