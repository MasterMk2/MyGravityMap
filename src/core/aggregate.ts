/**
 * 訪問 → 場所の集約と、年ごとの記録カバレッジの算出。
 * すべて純関数（Worker からもテストからも呼べる）。
 */
import type { Place, Visit, YearCoverage, YearStat, SemanticType } from './types'
import { localDayKey, localHour, localWeekday } from './geo'

/** 同じ場所とみなす距離（メートル）。placeId が無い滞在をグリッドに丸めるときの粒度 */
const GRID_METERS = 100

function gridKey(lat: number, lon: number): string {
  // 緯度 1 度 ≒ 111km。経度は緯度で縮むので cos を掛ける。
  const latStep = GRID_METERS / 111_320
  const lonStep = GRID_METERS / (111_320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)))
  return `grid:${Math.round(lat / latStep)}:${Math.round(lon / lonStep)}`
}

function emptyYearStat(): YearStat {
  return { days: 0, count: 0, reliableSeconds: 0, observedSeconds: 0 }
}

/** semanticType の優先度。より具体的な種別で上書きする */
const TYPE_RANK: Record<SemanticType, number> = {
  HOME: 5,
  WORK: 5,
  INFERRED_HOME: 3,
  INFERRED_WORK: 3,
  SEARCHED_ADDRESS: 2,
  UNKNOWN: 0,
}

/**
 * 訪問を場所へ集約する。
 *
 * hierarchyLevel 1 の訪問は level 0 と時間が重複する（実データで 623 件中 622 件）ため、
 * 滞在時間の集計からは除外する。level 1 は親（施設全体）として別に保持する。
 */
export function aggregatePlaces(visits: Visit[]): { places: Place[]; parents: Place[] } {
  const leaf = visits.filter((v) => v.hierarchyLevel === 0)
  const parent = visits.filter((v) => v.hierarchyLevel === 1)
  return { places: aggregate(leaf), parents: aggregate(parent) }
}

function aggregate(visits: Visit[]): Place[] {
  const byKey = new Map<string, Place>()
  // 場所ごとの「訪問した日」の集合。visitDays の算出に使う
  const daysByKey = new Map<string, Set<string>>()
  const yearDaysByKey = new Map<string, Map<number, Set<string>>>()
  // 代表点は滞在時間ではなく訪問回数で平均する（滞在時間は年によって信頼度が違うため）
  const sums = new Map<string, { lat: number; lon: number; n: number }>()

  for (const v of visits) {
    const key = v.placeId ?? gridKey(v.lat, v.lon)
    const dayKey = localDayKey(v.start, v.tzOffsetMin)
    const year = Number(dayKey.slice(0, 4))
    const seconds = Math.max(0, v.end - v.start)

    let p = byKey.get(key)
    if (!p) {
      p = {
        id: key,
        lat: v.lat,
        lon: v.lon,
        semanticType: v.semanticType,
        visitCount: 0,
        visitDays: 0,
        reliableSeconds: 0,
        observedSeconds: 0,
        firstSeen: v.start,
        lastSeen: v.end,
        byYear: {},
        byHour: new Int32Array(24),
        byWeekday: new Int32Array(7),
        sources: [],
      }
      byKey.set(key, p)
      daysByKey.set(key, new Set())
      yearDaysByKey.set(key, new Map())
      sums.set(key, { lat: 0, lon: 0, n: 0 })
    }

    p.visitCount += 1
    p.observedSeconds += seconds
    if (v.durationReliable) p.reliableSeconds += seconds
    p.firstSeen = Math.min(p.firstSeen, v.start)
    p.lastSeen = Math.max(p.lastSeen, v.end)
    if (TYPE_RANK[v.semanticType] > TYPE_RANK[p.semanticType]) p.semanticType = v.semanticType
    if (!p.sources.includes(v.source)) p.sources.push(v.source)

    p.byHour[localHour(v.start, v.tzOffsetMin)] += 1
    p.byWeekday[localWeekday(v.start, v.tzOffsetMin)] += 1

    const ys = (p.byYear[year] ??= emptyYearStat())
    ys.count += 1
    ys.observedSeconds += seconds
    if (v.durationReliable) ys.reliableSeconds += seconds

    daysByKey.get(key)!.add(dayKey)
    const ym = yearDaysByKey.get(key)!
    let yd = ym.get(year)
    if (!yd) ym.set(year, (yd = new Set()))
    yd.add(dayKey)

    const s = sums.get(key)!
    s.lat += v.lat
    s.lon += v.lon
    s.n += 1
  }

  for (const [key, p] of byKey) {
    p.visitDays = daysByKey.get(key)!.size
    for (const [year, days] of yearDaysByKey.get(key)!) {
      ;(p.byYear[year] ??= emptyYearStat()).days = days.size
    }
    const s = sums.get(key)!
    if (s.n > 0) {
      p.lat = s.lat / s.n
      p.lon = s.lon / s.n
    }
  }

  return [...byKey.values()].sort((a, b) => b.visitDays - a.visitDays)
}

/**
 * 年ごとの記録の濃さ。
 * timelinePath は 2 時間バケットなので「バケット数 × 2 時間 ÷ 記録日数」が
 * その年の 1 日あたりの記録カバレッジの目安になる（DESIGN.md §1.2.1）。
 */
export function computeCoverage(input: {
  /** timelinePath セグメントの [開始秒, tzOffsetMin] */
  pathBuckets: Array<[number, number]>
  /** Google の visit がある年の集合 */
  visitYears: Set<number>
}): YearCoverage[] {
  const daysByYear = new Map<number, Set<string>>()
  const bucketsByYear = new Map<number, number>()

  for (const [t, tz] of input.pathBuckets) {
    const day = localDayKey(t, tz)
    const year = Number(day.slice(0, 4))
    let set = daysByYear.get(year)
    if (!set) daysByYear.set(year, (set = new Set()))
    set.add(day)
    bucketsByYear.set(year, (bucketsByYear.get(year) ?? 0) + 1)
  }

  const years = [...new Set([...daysByYear.keys(), ...input.visitYears])].sort()
  return years.map((year) => {
    const recordedDays = daysByYear.get(year)?.size ?? 0
    const buckets = bucketsByYear.get(year) ?? 0
    return {
      year,
      recordedDays,
      coverageHoursPerDay: recordedDays > 0 ? (buckets * 2) / recordedDays : 0,
      hasGoogleVisits: input.visitYears.has(year),
    }
  })
}
