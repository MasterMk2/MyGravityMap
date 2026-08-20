/// <reference lib="webworker" />
/**
 * Google タイムラインの JSON をストリーミングで解析する Worker。
 *
 * 方針（DESIGN.md §3.2 / §9）:
 * - `rawSignals`（実データで 29.7 MB / Wi-Fi MAC アドレス 143,075 件）は
 *   件数を数えるだけで**一切保持しない**。パス指定で読み飛ばすので、
 *   一時的に構築されたオブジェクトも即座に捨てられる。
 * - ファイル全体を JSON.parse すると数百 MB のピークになるため、必ずストリームで読む。
 * - `°` を含む座標文字列がチャンク境界で割れても、パーサが UTF-8 を復元してから
 *   トークン化するので壊れない。
 */
import { JSONParser } from '@streamparser/json'
import type {
  Dataset,
  Move,
  ParseMessage,
  ParseStats,
  SemanticType,
  TrackPoint,
  TravelMode,
  Visit,
} from '../core/types'
import { parseLatLng, parseTimeSec, tzOffsetMinFromIso } from '../core/geo'
import { assignModes, buildTrips } from '../core/trips'
import { aggregatePlaces, computeCoverage } from '../core/aggregate'

interface RawLatLng {
  latLng?: string
}
interface RawSegment {
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

interface RawProfile {
  frequentPlaces?: Array<{ placeId?: string; placeLocation?: string; label?: string }>
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
 * 解析対象。通常はユーザーが選んだ File。
 * `url` は開発時だけ使う（dev サーバがリポジトリ内のファイルを配信できるため、
 * 手でファイル選択せずに動作確認できる）。本番ビルドでは呼ばれない。
 */
export type ParseSource =
  | { kind: 'file'; file: File }
  | { kind: 'url'; url: string; name: string }

self.onmessage = async (
  ev: MessageEvent<{ source: ParseSource; fileHash: string }>,
) => {
  const { source, fileHash } = ev.data
  try {
    const dataset = await parseSource(source, fileHash)
    post({ type: 'done', dataset })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

function post(m: ParseMessage) {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(m)
}

async function openStream(
  source: ParseSource,
): Promise<{ stream: ReadableStream<Uint8Array>; size: number; name: string }> {
  if (source.kind === 'file') {
    return { stream: source.file.stream(), size: source.file.size, name: source.file.name }
  }
  const res = await fetch(source.url)
  if (!res.ok || !res.body) throw new Error(`取得に失敗しました: ${res.status}`)
  const len = Number(res.headers.get('content-length') ?? 0)
  return { stream: res.body, size: len, name: source.name }
}

async function parseSource(source: ParseSource, fileHash: string): Promise<Dataset> {
  const points: TrackPoint[] = []
  const visits: Visit[] = []
  const moves: Move[] = []
  const anchors: Dataset['anchors'] = []
  /** 年カバレッジ用: timelinePath セグメントの開始時刻と TZ */
  const pathBuckets: Array<[number, number]> = []
  const visitYears = new Set<number>()

  const stats: ParseStats = {
    segments: 0,
    timelinePathPoints: 0,
    visitSegments: 0,
    activitySegments: 0,
    memorySegments: 0,
    rawSignalsDiscarded: 0,
    duplicateTimeFixed: 0,
    flightPointsInserted: 0,
  }

  const parser = new JSONParser({
    // rawSignals は「数えるためだけ」に拾う。値は即座に捨てるので保持されない。
    paths: ['$.semanticSegments.*', '$.rawSignals.*', '$.userLocationProfile'],
    keepStack: false,
    stringBufferSize: 64 * 1024,
  })

  parser.onValue = ({ value, key, stack }) => {
    const container = stack.length === 2 ? stack[1]?.key : undefined

    if (container === 'rawSignals') {
      stats.rawSignalsDiscarded += 1
      return // ★ MAC アドレスを含むため、ここから先へは絶対に渡さない
    }

    if (container === 'semanticSegments') {
      ingestSegment(value as unknown as RawSegment)
      return
    }

    if (stack.length === 1 && key === 'userLocationProfile') {
      ingestProfile(value as unknown as RawProfile)
    }
  }

  function ingestSegment(seg: RawSegment) {
    stats.segments += 1

    if (seg.timelinePath) {
      const tz = segmentTz(seg)
      if (seg.startTime) pathBuckets.push([parseTimeSec(seg.startTime), tz])
      for (const p of seg.timelinePath) {
        if (!p.point || !p.time) continue
        const [lat, lon] = parseLatLng(p.point)
        points.push({ t: parseTimeSec(p.time), lat, lon })
        stats.timelinePathPoints += 1
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
      stats.visitSegments += 1
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
      stats.activitySegments += 1
      return
    }

    if (seg.timelineMemory) stats.memorySegments += 1
  }

  function ingestProfile(profile: RawProfile) {
    for (const fp of profile.frequentPlaces ?? []) {
      if (!fp.placeId || !fp.placeLocation) continue
      const [lat, lon] = parseLatLng(fp.placeLocation)
      anchors.push({ placeId: fp.placeId, lat, lon, ...(fp.label ? { label: fp.label } : {}) })
    }
  }

  // --- ストリーム読み込み ---
  const { stream, size: total, name: fileName } = await openStream(source)
  let bytesRead = 0
  let lastPost = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytesRead += value.byteLength
    parser.write(value)
    const now = Date.now()
    if (now - lastPost > 120) {
      lastPost = now
      post({ type: 'progress', phase: '解析中', bytesRead, bytesTotal: total })
    }
  }
  try {
    parser.end()
  } catch {
    // ルート値が閉じた時点でパーサは自動的に終了する。
    // その後の end() は「既に終了済み」で throw するので無視してよい。
  }

  post({ type: 'progress', phase: '軌跡を組み立て中', bytesRead: total, bytesTotal: total })

  const built = buildTrips(points)
  stats.duplicateTimeFixed = built.duplicateTimeFixed
  stats.flightPointsInserted = built.flightPointsInserted
  const trips = assignModes(built.trips, moves)

  post({ type: 'progress', phase: '場所を集計中', bytesRead: total, bytesTotal: total })

  const { places } = aggregatePlaces(visits)
  const coverage = computeCoverage({ pathBuckets, visitYears })

  const times = [
    ...trips.map((t) => t.tStart),
    ...visits.map((v) => v.start),
    ...moves.map((m) => m.start),
  ]
  const ends = [
    ...trips.map((t) => t.tEnd),
    ...visits.map((v) => v.end),
    ...moves.map((m) => m.end),
  ]

  return {
    fileHash,
    fileName,
    parsedAt: Math.floor(Date.now() / 1000),
    tMin: times.length ? Math.min(...times) : 0,
    tMax: ends.length ? Math.max(...ends) : 0,
    trips,
    visits,
    moves,
    places,
    coverage,
    anchors,
    stats,
  }
}
