/**
 * Google タイムラインの `semanticSegments` を、このアプリのデータモデルへ正規化する。
 *
 * ストリーム読み込み・進捗通知・IndexedDB は含まない（それは Worker の仕事）。
 * ここを純粋にしておくと、同じ正規化を Worker 以外からも呼べる。
 * 復元パラメータの検証ハーネス（DESIGN.md 未決事項 D）が実際にそうしている:
 * 「アプリと違う読み方」で測ってしまうと、検証結果そのものが信用できなくなる。
 */
import type { Move, SemanticType, TrackPoint, TravelMode, Visit } from './types'
import { parseLatLng, parseTimeSec, tzOffsetMinFromIso } from './geo'

export interface RawLatLng {
  latLng?: string
}

export interface RawSegment {
  startTime?: string
  endTime?: string
  startTimeTimezoneUtcOffsetMinutes?: number
  endTimeTimezoneUtcOffsetMinutes?: number
  timelinePath?: Array<{ point?: string; time?: string }>
  visit?: {
    hierarchyLevel?: number
    probability?: number
    topCandidate?: {
      placeId?: string
      semanticType?: string
      probability?: number
      placeLocation?: RawLatLng
    }
  }
  activity?: {
    start?: RawLatLng
    end?: RawLatLng
    distanceMeters?: number
    probability?: number
    topCandidate?: { type?: string; probability?: number }
    parking?: { location?: RawLatLng; startTime?: string }
  }
  timelineMemory?: unknown
}

export interface RawProfile {
  frequentPlaces?: Array<{ placeId?: string; placeLocation?: string; label?: string }>
}

/** セグメントを積み上げた結果。Dataset を組み立てる材料になる。 */
export interface CollectedSegments {
  points: TrackPoint[]
  visits: Visit[]
  moves: Move[]
  anchors: Array<{ placeId: string; lat: number; lon: number; label?: string }>
  /** 年カバレッジ用: timelinePath セグメントの開始時刻と TZ */
  pathBuckets: Array<[number, number]>
  /** Google の visit がある年（記録側 TZ の暦年） */
  visitYears: Set<number>
  counts: {
    segments: number
    timelinePathPoints: number
    visitSegments: number
    activitySegments: number
    memorySegments: number
  }
}

const KNOWN_MODES = new Set<TravelMode>([
  'IN_PASSENGER_VEHICLE',
  'WALKING',
  'IN_TRAIN',
  'IN_BUS',
  'IN_TRAM',
  'IN_SUBWAY',
  'CYCLING',
  'MOTORCYCLING',
  'RUNNING',
  'FLYING',
])

const KNOWN_TYPES = new Set<SemanticType>([
  'HOME',
  'WORK',
  'INFERRED_HOME',
  'INFERRED_WORK',
  'SEARCHED_ADDRESS',
])

function toMode(s: string | undefined): TravelMode {
  return s && KNOWN_MODES.has(s as TravelMode) ? (s as TravelMode) : 'UNKNOWN'
}

function toSemanticType(s: string | undefined): SemanticType {
  return s && KNOWN_TYPES.has(s as SemanticType) ? (s as SemanticType) : 'UNKNOWN'
}

/** セグメントの UTC オフセット。明示フィールドが無ければ時刻文字列から拾う */
function segmentTz(seg: RawSegment): number {
  if (typeof seg.startTimeTimezoneUtcOffsetMinutes === 'number') {
    return seg.startTimeTimezoneUtcOffsetMinutes
  }
  if (!seg.startTime) return 0
  return tzOffsetMinFromIso(seg.startTime) ?? 0
}

/**
 * セグメントを 1 件ずつ受け取って積み上げる収集器。
 * 呼び出し側がストリームから読んだ順に ingestSegment を呼び、最後に result() を取る。
 */
export function createSegmentCollector() {
  const points: TrackPoint[] = []
  const visits: Visit[] = []
  const moves: Move[] = []
  const anchors: CollectedSegments['anchors'] = []
  const pathBuckets: Array<[number, number]> = []
  const visitYears = new Set<number>()
  const counts = {
    segments: 0,
    timelinePathPoints: 0,
    visitSegments: 0,
    activitySegments: 0,
    memorySegments: 0,
  }

  function ingestSegment(seg: RawSegment): void {
    counts.segments += 1

    if (seg.timelinePath) {
      const tz = segmentTz(seg)
      if (seg.startTime) pathBuckets.push([parseTimeSec(seg.startTime), tz])
      for (const p of seg.timelinePath) {
        if (!p.point || !p.time) continue
        const [lat, lon] = parseLatLng(p.point)
        points.push({ t: parseTimeSec(p.time), lat, lon })
        counts.timelinePathPoints += 1
      }
      return
    }

    if (seg.visit) {
      const tc = seg.visit.topCandidate
      const latLng = tc?.placeLocation?.latLng
      if (!latLng || !seg.startTime || !seg.endTime) return
      const [lat, lon] = parseLatLng(latLng)
      const start = parseTimeSec(seg.startTime)
      const tz = segmentTz(seg)
      const level = seg.visit.hierarchyLevel === 1 ? 1 : 0
      visits.push({
        start,
        end: parseTimeSec(seg.endTime),
        tzOffsetMin: tz,
        lat,
        lon,
        ...(tc?.placeId ? { placeId: tc.placeId } : {}),
        semanticType: toSemanticType(tc?.semanticType),
        hierarchyLevel: level,
        probability: seg.visit.probability ?? 0,
        source: 'google',
        // Google が出した visit は滞在時間を信用してよい（DESIGN.md §1.2.1）
        durationReliable: true,
      })
      visitYears.add(new Date((start + tz * 60) * 1000).getUTCFullYear())
      counts.visitSegments += 1
      return
    }

    if (seg.activity) {
      const a = seg.activity
      if (!a.start?.latLng || !a.end?.latLng || !seg.startTime || !seg.endTime) return
      const [fromLat, fromLon] = parseLatLng(a.start.latLng)
      const [toLat, toLon] = parseLatLng(a.end.latLng)
      const move: Move = {
        start: parseTimeSec(seg.startTime),
        end: parseTimeSec(seg.endTime),
        tzOffsetMin: segmentTz(seg),
        from: [fromLon, fromLat],
        to: [toLon, toLat],
        distanceMeters: a.distanceMeters ?? 0,
        mode: toMode(a.topCandidate?.type),
        probability: a.probability ?? 0,
      }
      if (a.parking?.location?.latLng && a.parking.startTime) {
        const [pLat, pLon] = parseLatLng(a.parking.location.latLng)
        move.parking = { lat: pLat, lon: pLon, t: parseTimeSec(a.parking.startTime) }
      }
      moves.push(move)
      counts.activitySegments += 1
      return
    }

    if (seg.timelineMemory) counts.memorySegments += 1
  }

  function ingestProfile(profile: RawProfile): void {
    for (const fp of profile.frequentPlaces ?? []) {
      if (!fp.placeId || !fp.placeLocation) continue
      const [lat, lon] = parseLatLng(fp.placeLocation)
      anchors.push({ placeId: fp.placeId, lat, lon, ...(fp.label ? { label: fp.label } : {}) })
    }
  }

  function result(): CollectedSegments {
    return { points, visits, moves, anchors, pathBuckets, visitYears, counts }
  }

  return { ingestSegment, ingestProfile, result }
}
