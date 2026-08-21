import { describe, it, expect } from 'vitest'
import type { Trip, Visit, YearCoverage } from '../src/core/types'
import { deriveVisitsFromTrips } from '../src/core/visits'

/**
 * deriveVisitsFromTrips の受け入れ基準（ジョブ「derive-visits-from-trajectory」のゲート）。
 *
 * 契約:
 * - trips[i] と trips[i+1] の間（トリップ間の隙間）だけを対象にする
 *   （trips 配列の外側 = 先頭より前・末尾より後は対象外。window の境界が無いため判定しようがない）
 * - 隙間の長さが minDwellSec 未満なら対象外
 * - 隙間の開始時刻（UTC）の暦年が coverage の hasGoogleVisits === true の年なら対象外
 *   （Google 自身のデータで既にカバーされているはずなので、推定を足すと二重・矛盾になる）
 * - 隙間が既存の visit（google 由来を含む）と重なっていれば対象外
 * - 生成する Visit は source: 'derived', durationReliable: false, semanticType: 'UNKNOWN'
 * - 座標は「隙間の直前のトリップ」の最後の点を使う（そこで動きが止まった＝滞在が始まった地点）
 * - placeId は付けない（Google のような場所IDを持たない）
 */

const DAY = 86400
const t2020 = Math.floor(Date.UTC(2020, 5, 15) / 1000) // 2020-06-15T00:00:00Z（hasGoogleVisits: false 年）
const t2025 = Math.floor(Date.UTC(2025, 5, 15) / 1000) // 2025-06-15T00:00:00Z（hasGoogleVisits: true 年）

/** 2点のみの最小 Trip。座標は最初と最後で明確に変える（アンカー判定用）。 */
function makeTrip(tStart: number, tEnd: number, fromLonLat: [number, number], toLonLat: [number, number]): Trip {
  const coords = new Float64Array([fromLonLat[0], fromLonLat[1], toLonLat[0], toLonLat[1]])
  return {
    coords,
    times: Int32Array.from([tStart, tEnd]),
    tStart,
    tEnd,
    mode: 'UNKNOWN',
    isFlight: false,
  }
}

function makeCoverage(year: number, hasGoogleVisits: boolean): YearCoverage {
  return { year, recordedDays: 300, coverageHoursPerDay: 2, hasGoogleVisits }
}

function makeGoogleVisit(start: number, end: number, lon: number, lat: number): Visit {
  return {
    start,
    end,
    tzOffsetMin: 540,
    lat,
    lon,
    semanticType: 'UNKNOWN',
    hierarchyLevel: 0,
    probability: 0.9,
    source: 'google',
    durationReliable: true,
  }
}

describe('deriveVisitsFromTrips', () => {
  it('returns [] for no trips', () => {
    expect(deriveVisitsFromTrips([], [], [])).toEqual([])
  })

  it('derives one visit for a qualifying gap in a year with no Google visit data', () => {
    const gapStart = t2020
    const gapEnd = t2020 + 2 * 3600 // 2時間の隙間
    const tripA = makeTrip(t2020 - 3600, gapStart, [139.6, 35.0], [139.7, 35.1]) // 直前トリップの最後の点
    const tripB = makeTrip(gapEnd, gapEnd + 3600, [139.9, 35.3], [140.0, 35.4])
    const coverage = [makeCoverage(2020, false)]

    const result = deriveVisitsFromTrips([tripA, tripB], [], coverage, 1200)

    expect(result).toHaveLength(1)
    const v = result[0]!
    expect(v.source).toBe('derived')
    expect(v.durationReliable).toBe(false)
    expect(v.semanticType).toBe('UNKNOWN')
    expect(v.placeId).toBeUndefined()
    expect(v.start).toBe(gapStart)
    expect(v.end).toBe(gapEnd)
    // アンカーは直前トリップ（tripA）の最後の点
    expect(v.lon).toBeCloseTo(139.7, 9)
    expect(v.lat).toBeCloseTo(35.1, 9)
    expect(v.probability).toBeGreaterThanOrEqual(0)
    expect(v.probability).toBeLessThanOrEqual(1)
    expect([0, 1]).toContain(v.hierarchyLevel)
  })

  it('skips a gap in a year where Google visit data already exists', () => {
    const gapStart = t2025
    const gapEnd = t2025 + 2 * 3600
    const tripA = makeTrip(t2025 - 3600, gapStart, [139.6, 35.0], [139.7, 35.1])
    const tripB = makeTrip(gapEnd, gapEnd + 3600, [139.9, 35.3], [140.0, 35.4])
    const coverage = [makeCoverage(2025, true)]

    expect(deriveVisitsFromTrips([tripA, tripB], [], coverage, 1200)).toEqual([])
  })

  it('skips a gap shorter than minDwellSec', () => {
    const gapStart = t2020
    const gapEnd = t2020 + 300 // 5分の隙間
    const tripA = makeTrip(t2020 - 3600, gapStart, [139.6, 35.0], [139.7, 35.1])
    const tripB = makeTrip(gapEnd, gapEnd + 3600, [139.9, 35.3], [140.0, 35.4])
    const coverage = [makeCoverage(2020, false)]

    expect(deriveVisitsFromTrips([tripA, tripB], [], coverage, 1200)).toEqual([])
  })

  it('has a usable default minDwellSec (a multi-hour gap qualifies without passing one)', () => {
    const gapStart = t2020
    const gapEnd = t2020 + 3 * 3600
    const tripA = makeTrip(t2020 - 3600, gapStart, [139.6, 35.0], [139.7, 35.1])
    const tripB = makeTrip(gapEnd, gapEnd + 3600, [139.9, 35.3], [140.0, 35.4])
    const coverage = [makeCoverage(2020, false)]

    const result = deriveVisitsFromTrips([tripA, tripB], [], coverage)
    expect(result).toHaveLength(1)
  })

  it('skips a gap that overlaps an existing visit, even in an uncovered year', () => {
    const gapStart = t2020
    const gapEnd = t2020 + 2 * 3600
    const tripA = makeTrip(t2020 - 3600, gapStart, [139.6, 35.0], [139.7, 35.1])
    const tripB = makeTrip(gapEnd, gapEnd + 3600, [139.9, 35.3], [140.0, 35.4])
    const coverage = [makeCoverage(2020, false)]
    const existing = [makeGoogleVisit(gapStart, gapEnd, 139.75, 35.15)]

    expect(deriveVisitsFromTrips([tripA, tripB], existing, coverage, 1200)).toEqual([])
  })

  it('does not derive anything before the first trip or after the last trip', () => {
    // trips 配列の外側は window が無く判定しようがないので、常に対象外
    const only = makeTrip(t2020, t2020 + DAY, [139.6, 35.0], [139.7, 35.1])
    const coverage = [makeCoverage(2020, false)]

    expect(deriveVisitsFromTrips([only], [], coverage, 1200)).toEqual([])
  })

  it('derives multiple visits for multiple qualifying gaps, in chronological order', () => {
    const gap1Start = t2020
    const gap1End = t2020 + 2 * 3600
    const gap2Start = gap1End + 3600
    const gap2End = gap2Start + 2 * 3600

    const tripA = makeTrip(t2020 - 3600, gap1Start, [139.6, 35.0], [139.61, 35.01])
    const tripB = makeTrip(gap1End, gap2Start, [139.7, 35.1], [139.71, 35.11])
    const tripC = makeTrip(gap2End, gap2End + 3600, [139.8, 35.2], [139.81, 35.21])
    const coverage = [makeCoverage(2020, false)]

    const result = deriveVisitsFromTrips([tripA, tripB, tripC], [], coverage, 1200)

    expect(result).toHaveLength(2)
    expect(result[0]!.start).toBe(gap1Start)
    expect(result[0]!.end).toBe(gap1End)
    expect(result[0]!.lon).toBeCloseTo(139.61, 9)
    expect(result[1]!.start).toBe(gap2Start)
    expect(result[1]!.end).toBe(gap2End)
    expect(result[1]!.lon).toBeCloseTo(139.71, 9)
  })
})
