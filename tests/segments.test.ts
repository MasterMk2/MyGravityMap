import { describe, expect, it } from 'vitest'
import { createSegmentCollector } from '../src/core/segments'
import type { RawSegment } from '../src/core/segments'

/**
 * セグメント正規化（Google の semanticSegments → このアプリのデータモデル）。
 * Worker から切り出す前はテストが無かった部分で、切り出しの動機のひとつでもある。
 * 座標はすべて架空（DESIGN.md §9: 実座標はテストにも置かない）。
 */

const TZ = '+09:00'

function collectOne(seg: RawSegment) {
  const c = createSegmentCollector()
  c.ingestSegment(seg)
  return c.result()
}

describe('createSegmentCollector', () => {
  it('timelinePath の点を TrackPoint にし、バケットの開始時刻を控える', () => {
    const r = collectOne({
      startTime: `2020-06-15T00:00:00.000${TZ}`,
      endTime: `2020-06-15T02:00:00.000${TZ}`,
      timelinePath: [
        { point: '35.1000000°, 139.7000000°', time: `2020-06-15T00:10:00.000${TZ}` },
        { point: '35.1010000°, 139.7010000°', time: `2020-06-15T00:20:00.000${TZ}` },
        { point: '35.1020000°, 139.7020000°' }, // 時刻が無い点は捨てる
      ],
    })

    expect(r.points).toHaveLength(2)
    expect(r.points[0]!.lat).toBeCloseTo(35.1, 9)
    expect(r.points[0]!.lon).toBeCloseTo(139.7, 9)
    expect(r.counts.timelinePathPoints).toBe(2)
    // バケットは「セグメントの開始時刻と TZ」。年カバレッジの計算に使う
    expect(r.pathBuckets).toHaveLength(1)
    expect(r.pathBuckets[0]![1]).toBe(540)
  })

  it('visit を Google 由来・滞在時間が信用できる Visit にする', () => {
    const r = collectOne({
      startTime: `2025-06-15T10:00:00.000${TZ}`,
      endTime: `2025-06-15T12:00:00.000${TZ}`,
      visit: {
        hierarchyLevel: 0,
        probability: 0.87,
        topCandidate: {
          placeId: 'PLACE_ID_FIXTURE',
          semanticType: 'HOME',
          placeLocation: { latLng: '35.2000000°, 139.8000000°' },
        },
      },
    })

    expect(r.visits).toHaveLength(1)
    const v = r.visits[0]!
    expect(v.source).toBe('google')
    expect(v.durationReliable).toBe(true)
    expect(v.semanticType).toBe('HOME')
    expect(v.placeId).toBe('PLACE_ID_FIXTURE')
    expect(v.hierarchyLevel).toBe(0)
    expect(v.end - v.start).toBe(2 * 3600)
    expect(v.tzOffsetMin).toBe(540)
    // 年は記録側 TZ の暦年で数える（UTC で数えると年末年始がずれる）
    expect([...r.visitYears]).toEqual([2025])
  })

  it('座標や時刻が欠けた visit は落とす', () => {
    const noLatLng = collectOne({
      startTime: `2025-06-15T10:00:00.000${TZ}`,
      endTime: `2025-06-15T12:00:00.000${TZ}`,
      visit: { topCandidate: { semanticType: 'HOME' } },
    })
    expect(noLatLng.visits).toEqual([])
    // セグメント自体は数える（形式判定に使うため）
    expect(noLatLng.counts.segments).toBe(1)
  })

  it('未知の semanticType / 交通手段は UNKNOWN に丸める', () => {
    const r = collectOne({
      startTime: `2025-06-15T10:00:00.000${TZ}`,
      endTime: `2025-06-15T12:00:00.000${TZ}`,
      visit: {
        topCandidate: {
          semanticType: 'SOME_FUTURE_TYPE',
          placeLocation: { latLng: '35.2000000°, 139.8000000°' },
        },
      },
    })
    expect(r.visits[0]!.semanticType).toBe('UNKNOWN')
  })

  it('activity を Move にし、駐車地点も拾う', () => {
    const r = collectOne({
      startTime: `2025-06-15T08:00:00.000${TZ}`,
      endTime: `2025-06-15T08:30:00.000${TZ}`,
      activity: {
        start: { latLng: '35.1000000°, 139.7000000°' },
        end: { latLng: '35.2000000°, 139.8000000°' },
        distanceMeters: 12345,
        probability: 0.9,
        topCandidate: { type: 'IN_PASSENGER_VEHICLE' },
        parking: {
          location: { latLng: '35.2001000°, 139.8001000°' },
          startTime: `2025-06-15T08:29:00.000${TZ}`,
        },
      },
    })

    expect(r.moves).toHaveLength(1)
    const m = r.moves[0]!
    expect(m.mode).toBe('IN_PASSENGER_VEHICLE')
    expect(m.distanceMeters).toBe(12345)
    // Move の座標は [lon, lat] の順（GeoJSON に合わせる）
    expect(m.from[0]).toBeCloseTo(139.7, 9)
    expect(m.from[1]).toBeCloseTo(35.1, 9)
    expect(m.parking?.t).toBe(m.end - 60)
  })

  it('timelineMemory は数えるだけ', () => {
    const r = collectOne({ timelineMemory: { trip: {} } })
    expect(r.counts.memorySegments).toBe(1)
    expect(r.points).toEqual([])
    expect(r.visits).toEqual([])
    expect(r.moves).toEqual([])
  })

  it('明示の TZ フィールドがあれば時刻文字列より優先する', () => {
    const r = collectOne({
      startTime: `2025-06-15T10:00:00.000${TZ}`,
      endTime: `2025-06-15T12:00:00.000${TZ}`,
      startTimeTimezoneUtcOffsetMinutes: -300,
      visit: {
        topCandidate: { placeLocation: { latLng: '35.2000000°, 139.8000000°' } },
      },
    })
    expect(r.visits[0]!.tzOffsetMin).toBe(-300)
  })

  it('userLocationProfile の frequentPlaces をアンカーにする', () => {
    const c = createSegmentCollector()
    c.ingestProfile({
      frequentPlaces: [
        { placeId: 'A', placeLocation: '35.3000000°, 139.9000000°', label: 'HOME' },
        { placeId: 'B', placeLocation: '35.4000000°, 140.0000000°' },
        { placeLocation: '35.5000000°, 140.1000000°' }, // placeId 無しは捨てる
      ],
    })
    const r = c.result()
    expect(r.anchors).toHaveLength(2)
    expect(r.anchors[0]!.label).toBe('HOME')
    expect(r.anchors[1]!.label).toBeUndefined()
  })

  it('複数セグメントを積み上げて件数を数える', () => {
    const c = createSegmentCollector()
    c.ingestSegment({
      startTime: `2020-06-15T00:00:00.000${TZ}`,
      timelinePath: [{ point: '35.1000000°, 139.7000000°', time: `2020-06-15T00:10:00.000${TZ}` }],
    })
    c.ingestSegment({
      startTime: `2025-06-15T10:00:00.000${TZ}`,
      endTime: `2025-06-15T12:00:00.000${TZ}`,
      visit: { topCandidate: { placeLocation: { latLng: '35.2000000°, 139.8000000°' } } },
    })
    c.ingestSegment({ timelineMemory: {} })

    const r = c.result()
    expect(r.counts).toEqual({
      segments: 3,
      timelinePathPoints: 1,
      visitSegments: 1,
      activitySegments: 0,
      memorySegments: 1,
    })
  })
})
