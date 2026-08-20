import { describe, expect, it } from 'vitest'
import { positionAt } from '../src/playback/position'
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
