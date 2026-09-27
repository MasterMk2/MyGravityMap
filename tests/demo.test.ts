import { beforeAll, describe, expect, it } from 'vitest'
import { DEMO_DENSE_FROM, DEMO_VERSION, generateDemoHistory } from '../src/demo/generate'
import type { DemoHistory } from '../src/demo/generate'
import { createSegmentCollector } from '../src/core/segments'
import { buildDataset } from '../src/core/pipeline'
import { haversineMeters, parseLatLng, parseTimeSec, tzOffsetMinFromIso } from '../src/core/geo'
import type { Dataset } from '../src/core/types'

/**
 * デモ用の合成データ（DESIGN.md §8 C）。
 * 見ているのは 2 つ:
 * - 生成器が実データの性質（年による記録の非対称・海外の TZ・飛行機）を再現しているか
 * - 実ファイルと同じ収集器とパイプラインを通したとき、アプリの各ビューが使う材料が揃うか
 * 座標はすべて架空の人物のもの（src/demo/generate.ts の冒頭）。
 */

/** 32 ビット FNV-1a。出力が 1 文字でも変わったかを見るだけなので、暗号学的な強さは要らない */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Worker と同じ順で収集器 → buildDataset に通す */
function toDataset(h: DemoHistory): Dataset {
  const c = createSegmentCollector()
  for (const s of h.semanticSegments) c.ingestSegment(s)
  c.ingestProfile(h.userLocationProfile)
  return buildDataset({
    collected: c.result(),
    fileHash: 'demo:test',
    fileName: 'demo',
    rawSignalsDiscarded: 0,
    parsedAt: 0,
  })
}

const DENSE_FROM_SEC = parseTimeSec(`${DEMO_DENSE_FROM}T00:00:00.000+09:00`)
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000[+-]\d{2}:\d{2}$/
const POINT = /^-?\d+\.\d{7}°, -?\d+\.\d{7}°$/

const yearOf = (t: number) => new Date(t * 1000).getUTCFullYear()

let full: DemoHistory
let dataset: Dataset

beforeAll(() => {
  // 全期間を 1 回だけ作って使い回す（生成＋パイプラインで 1 秒弱）
  full = generateDemoHistory()
  dataset = toDataset(full)
}, 60_000)

describe('generateDemoHistory: 決定性', () => {
  it('同じ seed なら同じ出力、seed を変えれば別の出力', () => {
    const range = { start: '2024-09-20', end: '2024-10-20' }
    const a = JSON.stringify(generateDemoHistory(7, range))
    const b = JSON.stringify(generateDemoHistory(7, range))
    const c = JSON.stringify(generateDemoHistory(8, range))
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })

  it('既定の出力は固定（変えたら DEMO_VERSION を上げる）', () => {
    // 解析結果は demo:<seed>:v<DEMO_VERSION>:p<PIPELINE_VERSION> をキーに IndexedDB に残る。
    // 出力が変わったのに版を上げないと、前に開いた人には古いデモが出続ける。
    // ここが落ちたら DEMO_VERSION を上げてから、下の値を新しい出力に合わせる。
    expect({
      version: DEMO_VERSION,
      segments: full.semanticSegments.length,
      hash: fnv1a(JSON.stringify(full)),
    }).toEqual({ version: 1, segments: 14415, hash: 'b88ce2a6' })
  })
})

describe('generateDemoHistory: 形式', () => {
  it('Google の書き出しと同じ形（オフセット付き時刻・度記号付き座標・時刻順・2 時間バケット）', () => {
    const bad: string[] = []
    let prev = -Infinity
    for (const [i, s] of full.semanticSegments.entries()) {
      const where = `#${i} ${s.startTime}`
      if (!s.startTime || !ISO.test(s.startTime) || !s.endTime || !ISO.test(s.endTime)) bad.push(`${where}: 時刻`)
      if (s.startTimeTimezoneUtcOffsetMinutes !== tzOffsetMinFromIso(s.startTime ?? '')) bad.push(`${where}: TZ`)
      const start = parseTimeSec(s.startTime ?? '')
      if (start < prev) bad.push(`${where}: 時刻順`)
      prev = start
      if (s.timelinePath) {
        const end = parseTimeSec(s.endTime ?? '')
        if (end - start !== 7200) bad.push(`${where}: バケット幅`)
        for (const p of s.timelinePath) {
          if (!p.point || !POINT.test(p.point) || !p.time || !ISO.test(p.time)) bad.push(`${where}: 点の形式`)
          const t = parseTimeSec(p.time ?? '')
          if (t < start || t >= end) bad.push(`${where}: 点がバケットの外`)
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([])
  })

  it('2024-10-01 より前は timelinePath だけ、それ以降は visit と activity もある（DESIGN.md §1.2）', () => {
    const before = full.semanticSegments.filter((s) => parseTimeSec(s.startTime!) < DENSE_FROM_SEC)
    const after = full.semanticSegments.filter((s) => parseTimeSec(s.startTime!) >= DENSE_FROM_SEC)
    expect(before.length).toBeGreaterThan(0)
    expect(before.filter((s) => !s.timelinePath)).toEqual([])
    expect(after.filter((s) => s.visit).length).toBeGreaterThan(1000)
    expect(after.filter((s) => s.activity).length).toBeGreaterThan(1000)
    expect(after.some((s) => s.visit?.hierarchyLevel === 1)).toBe(true)
    expect(after.some((s) => s.timelineMemory)).toBe(true)
  })

  it('軌跡の点は 6〜12 万点（Worker が数秒で終わる規模）', () => {
    let points = 0
    for (const s of full.semanticSegments) points += s.timelinePath?.length ?? 0
    expect(points).toBeGreaterThanOrEqual(60_000)
    expect(points).toBeLessThanOrEqual(120_000)
  })

  it('placeId ごとに座標が固定で、frequentPlaces の HOME / WORK は visit と同じ placeId', () => {
    const coords = new Map<string, string>()
    const types = new Map<string, Set<string>>()
    const moved: string[] = []
    for (const s of full.semanticSegments) {
      const tc = s.visit?.topCandidate
      if (!tc?.placeId) continue
      const ll = tc.placeLocation?.latLng ?? ''
      const seen = coords.get(tc.placeId)
      if (seen === undefined) coords.set(tc.placeId, ll)
      else if (seen !== ll) moved.push(tc.placeId)
      if (!types.has(tc.placeId)) types.set(tc.placeId, new Set())
      types.get(tc.placeId)!.add(tc.semanticType ?? '')
    }
    expect(moved).toEqual([])
    expect([...coords.keys()].every((id) => /^demo-place-\d+$/.test(id))).toBe(true)

    const fp = full.userLocationProfile.frequentPlaces ?? []
    const home = fp.find((p) => p.label === 'HOME')
    const work = fp.find((p) => p.label === 'WORK')
    expect(types.get(home?.placeId ?? '')).toContain('HOME')
    expect(types.get(work?.placeId ?? '')).toContain('WORK')
    expect(coords.get(home!.placeId!)).toBe(home!.placeLocation)
  })

  it('期間を縮めると、その範囲（日本時間）の中だけを出す', () => {
    const h = generateDemoHistory(1, { start: '2025-01-06', end: '2025-01-12' })
    const from = parseTimeSec('2025-01-06T00:00:00.000+09:00')
    const to = parseTimeSec('2025-01-13T00:00:00.000+09:00')
    expect(h.semanticSegments.length).toBeGreaterThan(0)
    expect(h.semanticSegments.every((s) => parseTimeSec(s.startTime!) >= from && parseTimeSec(s.endTime!) <= to)).toBe(
      true,
    )
    expect(() => generateDemoHistory(1, { start: '2025-01-12', end: '2025-01-06' })).toThrow()
    expect(() => generateDemoHistory(1, { start: '2025/01/12' })).toThrow()
  })
})

describe('実ファイルと同じパイプラインに通す', () => {
  it('軌跡・場所・飛行機がそろう', () => {
    expect(dataset.trips.length).toBeGreaterThan(1000)
    expect(dataset.places.length).toBeGreaterThan(20)
    expect(dataset.trips.some((t) => t.isFlight)).toBe(true)
    expect(dataset.stats.flightPointsInserted).toBeGreaterThan(0)
    expect(dataset.stats.duplicateTimeFixed).toBe(0)
    expect(dataset.anchors.map((a) => a.label).sort()).toEqual(['HOME', 'WORK'])
  })

  it('年カバレッジ: 2019〜2023 は Google の visit が無く薄い、2025 は visit があり濃い（DESIGN.md §1.2.1）', () => {
    const cov = new Map(dataset.coverage.map((c) => [c.year, c]))
    for (const year of [2019, 2020, 2021, 2022, 2023]) {
      const c = cov.get(year)!
      expect(c.hasGoogleVisits).toBe(false)
      // 実データの 2019〜2022 年は 1 日 5.5〜6.9 時間
      expect(c.coverageHoursPerDay).toBeGreaterThan(4)
      expect(c.coverageHoursPerDay).toBeLessThan(8)
    }
    const y2025 = cov.get(2025)!
    expect(y2025.hasGoogleVisits).toBe(true)
    // 実データの 2025 年は 1 日 15.5 時間
    expect(y2025.coverageHoursPerDay).toBeGreaterThan(12)
    expect(y2025.coverageHoursPerDay).toBeLessThan(18)
  })

  it('海外の TZ（台北 +8・ヘルシンキ夏時間 +3）が切り替わり点に残る', () => {
    const offsets = new Set(dataset.tzChanges.map((c) => c[1]))
    expect(offsets).toContain(540)
    expect(offsets).toContain(480)
    expect(offsets).toContain(180)
  })

  it('visit の無い年は軌跡から滞在が復元され、visit のある年には復元しない', () => {
    const derivedYears = new Set(dataset.visits.filter((v) => v.source === 'derived').map((v) => yearOf(v.start)))
    for (const year of [2019, 2020, 2021, 2022, 2023]) expect(derivedYears).toContain(year)
    expect(derivedYears).not.toContain(2025)
    expect(dataset.visits.some((v) => v.source === 'google')).toBe(true)
  })

  it('交通手段がひと通り出る', () => {
    const modes = new Set(dataset.moves.map((m) => m.mode))
    for (const m of ['IN_PASSENGER_VEHICLE', 'WALKING', 'IN_TRAIN', 'IN_BUS', 'IN_SUBWAY', 'CYCLING', 'FLYING'] as const) {
      expect(modes).toContain(m)
    }
  })

  it('転居と転職で、年ごとの重心が札幌の中で動く', () => {
    // 札幌から 30km 以内の軌跡の点の平均。旅行先は重心の議論から外す
    const sapporo = parseLatLng('43.0621°, 141.3544°')
    const centroid = (year: number) => {
      let lat = 0
      let lon = 0
      let n = 0
      for (const trip of dataset.trips) {
        for (let i = 0; i < trip.times.length; i++) {
          if (yearOf(trip.times[i]) !== year) continue
          const pLon = trip.coords[i * 2]
          const pLat = trip.coords[i * 2 + 1]
          if (haversineMeters(pLat, pLon, sapporo[0], sapporo[1]) > 30_000) continue
          lat += pLat
          lon += pLon
          n += 1
        }
      }
      return [lat / n, lon / n] as const
    }
    const [aLat, aLon] = centroid(2020)
    const [bLat, bLon] = centroid(2025)
    expect(haversineMeters(aLat, aLon, bLat, bLon)).toBeGreaterThan(1_500)
  })
})
