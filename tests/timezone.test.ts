import { describe, expect, it } from 'vitest'
import { createTzLookup, FALLBACK_TZ_MIN, localDayRange } from '../src/core/timezone'
import { createSegmentCollector } from '../src/core/segments'
import { buildDataset } from '../src/core/pipeline'
import { localDayKey } from '../src/core/geo'

/** 座標はすべて架空（DESIGN.md §9） */

describe('createTzLookup', () => {
  it('切り替わり点が無ければ既定（JST）を返す', () => {
    expect(createTzLookup([])(1_700_000_000)).toBe(FALLBACK_TZ_MIN)
  })

  it('その時刻に有効だったオフセットを返す（前・境界・間・後ろ）', () => {
    const tz = createTzLookup([
      [1000, 540],
      [2000, 60],
      [3000, 540],
    ])
    expect(tz(500)).toBe(540) // 最初の点より前は最初の点のオフセット
    expect(tz(1000)).toBe(540)
    expect(tz(1999)).toBe(540)
    expect(tz(2000)).toBe(60)
    expect(tz(2500)).toBe(60)
    expect(tz(9999)).toBe(540)
  })
})

describe('localDayRange', () => {
  it('記録側の暦日の 0 時から 24 時間を返し、localDayKey と往復できる', () => {
    const [start, end] = localDayRange('2025-03-14', 540)
    expect(end - start).toBe(86400)
    expect(localDayKey(start, 540)).toBe('2025-03-14')
    expect(localDayKey(end - 1, 540)).toBe('2025-03-14')
    expect(localDayKey(end, 540)).toBe('2025-03-15')
  })
})

describe('tzChanges の収集', () => {
  it('セグメント種別を問わず TZ を拾い、時刻順に並べて変化点だけを残す', () => {
    const c = createSegmentCollector()
    // わざと時刻順を崩して渡す（ストリームの順序に依存しないこと）
    c.ingestSegment({
      startTime: '2025-06-02T10:00:00.000+01:00',
      endTime: '2025-06-02T11:00:00.000+01:00',
      visit: {
        topCandidate: { placeLocation: { latLng: '48.0000000°, 2.0000000°' } },
      },
    })
    c.ingestSegment({
      startTime: '2025-06-01T08:00:00.000+09:00',
      endTime: '2025-06-01T10:00:00.000+09:00',
      timelinePath: [{ point: '35.0000000°, 139.0000000°', time: '2025-06-01T08:10:00.000+09:00' }],
    })
    c.ingestSegment({
      startTime: '2025-06-01T12:00:00.000+09:00',
      endTime: '2025-06-01T14:00:00.000+09:00',
      timelinePath: [{ point: '35.0010000°, 139.0010000°', time: '2025-06-01T12:10:00.000+09:00' }],
    })
    const r = c.result()
    expect(r.tzChanges.map((x) => x[1])).toEqual([540, 60])
    expect(r.tzChanges[0]![0]).toBeLessThan(r.tzChanges[1]![0])
  })
})

describe('buildDataset', () => {
  it('収集結果から Dataset を組み立て、tzChanges と期間を持たせる', () => {
    const c = createSegmentCollector()
    c.ingestSegment({
      startTime: '2020-06-15T00:00:00.000+09:00',
      endTime: '2020-06-15T02:00:00.000+09:00',
      timelinePath: [
        { point: '35.1000000°, 139.7000000°', time: '2020-06-15T00:10:00.000+09:00' },
        { point: '35.1010000°, 139.7010000°', time: '2020-06-15T00:20:00.000+09:00' },
      ],
    })
    const phases: string[] = []
    const d = buildDataset({
      collected: c.result(),
      fileHash: 'h',
      fileName: 'f.json',
      rawSignalsDiscarded: 3,
      parsedAt: 42,
      onPhase: (p) => phases.push(p),
    })
    expect(d.trips).toHaveLength(1)
    expect(d.tzChanges).toEqual([[d.tzChanges[0]![0], 540]])
    expect(d.tMin).toBe(d.trips[0]!.tStart)
    expect(d.tMax).toBe(d.trips[0]!.tEnd)
    expect(d.stats.rawSignalsDiscarded).toBe(3)
    expect(d.parsedAt).toBe(42)
    expect(phases.length).toBeGreaterThan(0)
  })
})

describe('buildDataset: 復元した滞在の TZ', () => {
  it('軌跡から復元した滞在に記録側の TZ を入れる（UTC のままにしない）', () => {
    const c = createSegmentCollector()
    const seg = (h: number, lat: string) => ({
      startTime: `2020-06-15T${String(h).padStart(2, '0')}:00:00.000+09:00`,
      endTime: `2020-06-15T${String(h + 1).padStart(2, '0')}:00:00.000+09:00`,
      timelinePath: [
        { point: `${lat}°, 139.7000000°`, time: `2020-06-15T${String(h).padStart(2, '0')}:05:00.000+09:00` },
        { point: `${lat}°, 139.7000100°`, time: `2020-06-15T${String(h).padStart(2, '0')}:15:00.000+09:00` },
      ],
    })
    // 08 時台と 12 時台の間に 3 時間以上の空白（同じ場所）→ 滞在として復元される
    c.ingestSegment(seg(8, '35.1000000'))
    c.ingestSegment(seg(12, '35.1000100'))
    const d = buildDataset({
      collected: c.result(),
      fileHash: 'h',
      fileName: 'f.json',
      rawSignalsDiscarded: 0,
      parsedAt: 0,
    })
    const derived = d.visits.filter((v) => v.source === 'derived')
    expect(derived).toHaveLength(1)
    expect(derived[0]!.tzOffsetMin).toBe(540)
  })
})
