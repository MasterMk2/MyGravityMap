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
import type { Dataset, ParseMessage, ParseStats } from '../core/types'
import { createSegmentCollector } from '../core/segments'
import type { RawProfile, RawSegment } from '../core/segments'
import { assignModes, buildTrips } from '../core/trips'
import { aggregatePlaces, computeCoverage } from '../core/aggregate'
import { deriveVisitsFromTrips } from '../core/visits'

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
  const collector = createSegmentCollector()
  // 収集器が数えない分（rawSignals は Worker でしか通らない、残り 2 つは trip 構築の副産物）
  let rawSignalsDiscarded = 0

  const parser = new JSONParser({
    // rawSignals は「数えるためだけ」に拾う。値は即座に捨てるので保持されない。
    paths: ['$.semanticSegments.*', '$.rawSignals.*', '$.userLocationProfile'],
    keepStack: false,
    stringBufferSize: 64 * 1024,
  })

  parser.onValue = ({ value, key, stack }) => {
    const container = stack.length === 2 ? stack[1]?.key : undefined

    if (container === 'rawSignals') {
      rawSignalsDiscarded += 1
      return // ★ MAC アドレスを含むため、ここから先へは絶対に渡さない
    }

    if (container === 'semanticSegments') {
      collector.ingestSegment(value as unknown as RawSegment)
      return
    }

    if (stack.length === 1 && key === 'userLocationProfile') {
      collector.ingestProfile(value as unknown as RawProfile)
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

  const { points, visits, moves, anchors, pathBuckets, visitYears, counts } = collector.result()

  if (counts.segments === 0) {
    // 形式違いのファイルを黙って「0 件」で開くと、利用者は原因が分からない。
    throw new Error(
      'このファイルには semanticSegments が見つかりませんでした。' +
        'Google マップアプリから書き出した新しい形式のタイムライン（location-history.json / タイムライン.json）を選んでください。' +
        'Google データエクスポート（Takeout）の古い形式（Records.json や「セマンティック ロケーション履歴」フォルダ）にはまだ対応していません。',
    )
  }

  post({ type: 'progress', phase: '軌跡を組み立て中', bytesRead: total, bytesTotal: total })

  const built = buildTrips(points)
  const trips = assignModes(built.trips, moves)

  const stats: ParseStats = {
    ...counts,
    rawSignalsDiscarded,
    duplicateTimeFixed: built.duplicateTimeFixed,
    flightPointsInserted: built.flightPointsInserted,
  }

  post({ type: 'progress', phase: '場所を集計中', bytesRead: total, bytesTotal: total })

  // coverage は Google の訪問データが無い年を判定するために使うので、
  // 訪問の復元（deriveVisitsFromTrips）より先に求めておく必要がある。
  const coverage = computeCoverage({ pathBuckets, visitYears })
  const derivedVisits = deriveVisitsFromTrips(trips, visits, coverage)
  const allVisits = [...visits, ...derivedVisits]
  const { places } = aggregatePlaces(allVisits)

  const times = [
    ...trips.map((t) => t.tStart),
    ...allVisits.map((v) => v.start),
    ...moves.map((m) => m.start),
  ]
  const ends = [
    ...trips.map((t) => t.tEnd),
    ...allVisits.map((v) => v.end),
    ...moves.map((m) => m.end),
  ]

  return {
    fileHash,
    fileName,
    parsedAt: Math.floor(Date.now() / 1000),
    tMin: times.length ? Math.min(...times) : 0,
    tMax: ends.length ? Math.max(...ends) : 0,
    trips,
    visits: allVisits,
    moves,
    places,
    coverage,
    anchors,
    stats,
  }
}
