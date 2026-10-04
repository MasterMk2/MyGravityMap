import { describe, expect, it } from 'vitest'
import { importCacheKey, validateTripGapSec } from '../src/core/importSettings'
import { buildDataset } from '../src/core/pipeline'
import { createSegmentCollector } from '../src/core/segments'
import { useAppStore } from '../src/store/useAppStore'

describe('trip import threshold', () => {
  it('validates bounds and rejects malformed values', () => {
    for (const bad of [0, -1, NaN, Infinity, 59, 86401, 60.5, '1800', null]) {
      expect(() => validateTripGapSec(bad)).toThrow(RangeError)
    }
    expect(validateTripGapSec(60)).toBe(60)
    expect(validateTripGapSec(86400)).toBe(86400)
  })
  it('separates caches without changing the existing default key', () => {
    expect(importCacheKey('hash', 1800, 3)).toBe('hash:p3')
    expect(importCacheKey('hash', 600, 3)).toBe('hash:gap600:p3')
  })
  it('rebuilds from original points without mutating them', () => {
    const collected = createSegmentCollector().result()
    collected.points = [{ t: 1000, lon: 10, lat: 30 }, { t: 1900, lon: 10.001, lat: 30 }]
    const before = JSON.stringify(collected.points)
    const input = { collected, fileHash: 'synthetic', fileName: 'fixture', parsedAt: 0, rawSignalsDiscarded: 0 }
    expect(buildDataset(input).trips).toHaveLength(1)
    expect(buildDataset({ ...input, tripGapSec: 600 }).trips).toHaveLength(2)
    expect(JSON.stringify(collected.points)).toBe(before)
  })
  it('locks settings during imports and preserves valid settings across reset', () => {
    useAppStore.setState({ status: 'idle', tripGapSec: 1800 })
    useAppStore.getState().setTripGapSec(600)
    useAppStore.setState({ status: 'parsing' })
    useAppStore.getState().setTripGapSec(900)
    expect(useAppStore.getState().tripGapSec).toBe(600)
    useAppStore.getState().reset()
    expect(useAppStore.getState().tripGapSec).toBe(600)
    expect(() => useAppStore.getState().setTripGapSec(-1)).toThrow()
    useAppStore.setState({ tripGapSec: 1800 })
  })
})
