import type { WeightedPoints } from './weights'
import { aggregateToCells } from './weights'

export type GravityNormalization = 'raw' | 'year-percentile'

/** Midrank CDF among observed positive cells: ties share (below + tied/2)/n.
 * Zero/negative/non-finite values do not rank and remain zero. A singleton is 0.5.
 */
export function percentileWeights(values: Float32Array): Float32Array {
  const sorted = Array.from(values).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b)
  const ranks = new Map<number, number>()
  for (let i = 0; i < sorted.length;) {
    let end = i + 1
    while (end < sorted.length && sorted[end] === sorted[i]) end++
    ranks.set(sorted[i]!, (i + (end - i) / 2) / sorted.length)
    i = end
  }
  return values.map((value) => ranks.get(value) ?? 0)
}

/** Equal-year mean. Empty years do not dilute results; an absent cell in an
 * observed year contributes zero. First aggregate, then rank to avoid sampling-density bias.
 */
export function normalizeYearlyCells(years: WeightedPoints[], cellMeters: number): WeightedPoints {
  const cells = years.map((year) => aggregateToCells(year, cellMeters))
    .filter((year) => year.weights.some((weight) => Number.isFinite(weight) && weight > 0))
  const positions: number[] = []
  const weights: number[] = []
  for (const year of cells) {
    const ranks = percentileWeights(year.weights)
    for (let i = 0; i < year.count; i++) {
      if (!ranks[i]) continue
      positions.push(year.positions[i * 2]!, year.positions[i * 2 + 1]!)
      weights.push(ranks[i]! / cells.length)
    }
  }
  const combined: WeightedPoints = {
    positions: Float32Array.from(positions), weights: Float32Array.from(weights),
    count: weights.length, total: weights.reduce((a, b) => a + b, 0), unit: 'percentile',
  }
  return combined.count ? aggregateToCells(combined, cellMeters) : combined
}
