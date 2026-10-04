import { describe, expect, it } from 'vitest'
import { normalizeYearlyCells, percentileWeights } from '../src/gravity/normalization'
import { buildWeightedPoints, type WeightedPoints } from '../src/gravity/weights'
import { buildDataset } from '../src/core/pipeline'
import { createSegmentCollector } from '../src/core/segments'

function points(weights: number[], lons = [10, 20, 30]): WeightedPoints {
  return { positions: Float32Array.from(weights.flatMap((_, i) => [lons[i]!, 30])),
    weights: Float32Array.from(weights), count: weights.length,
    total: weights.reduce((a, b) => a + b, 0), unit: 'days' }
}

describe('within-year normalization', () => {
  it('gives ties the same midrank; zeros, negatives and missing values stay zero', () => {
    expect([...percentileWeights(Float32Array.from([0, 10, 10, 20, NaN, -1, Infinity]))])
      .toEqual([0, 1 / 3, 1 / 3, 5 / 6, 0, 0, 0].map(Math.fround))
    expect([...percentileWeights(Float32Array.from([42]))]).toEqual([.5])
    expect([...percentileWeights(new Float32Array())]).toEqual([])
  })
  it('averages observed years equally regardless of raw magnitude and skips empty years', () => {
    const normalized = normalizeYearlyCells([points([1, 3]), points([]), points([100, 300])], 100)
    expect([...normalized.weights]).toEqual([.25, .75])
    expect(normalized.unit).toBe('percentile')
  })
  it('counts an unvisited cell as zero in years that do have observations', () => {
    expect([...normalizeYearlyCells([points([1], [10]), points([1], [20])], 100).weights]).toEqual([.25, .25])
  })
  it('aggregates samples before ranking and leaves source arrays untouched', () => {
    const source = points([2, 2, 3], [10, 10, 20])
    const before = [...source.weights]
    expect([...normalizeYearlyCells([source], 100).weights]).toEqual([.75, .25])
    expect([...source.weights]).toEqual(before)
  })
  it('retains empty percentile units and ignores invalid/zero-only years', () => {
    const result = normalizeYearlyCells([points([0, NaN, -1])], 100)
    expect(result.count).toBe(0)
    expect(result.unit).toBe('percentile')
  })
  it('splits UTC years without duplicating Jan 1 samples; raw output remains available', () => {
    const collected = createSegmentCollector().result()
    const jan = Date.UTC(2025, 0, 1) / 1000
    collected.points = [{ t: jan - 60, lat: 30, lon: 10 }, { t: jan, lat: 30, lon: 20 }]
    const data = buildDataset({ collected, fileHash: 'synthetic', fileName: 'fixture', parsedAt: 0, rawSignalsDiscarded: 0 })
    const window = { start: jan - 60, end: jan }
    const raw = buildWeightedPoints(data, data.trips, window, 'track', 100)
    const normalized = buildWeightedPoints(data, data.trips, window, 'track', 100, 'year-percentile')
    expect(raw.unit).toBe('seconds')
    expect(normalized.unit).toBe('percentile')
    expect(normalized.count).toBeGreaterThan(0)
    expect([...normalized.weights].every((n) => n >= 0 && n <= 1)).toBe(true)
  })
})
