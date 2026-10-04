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
import type { Dataset, ParseMessage } from '../core/types'
import { createSegmentCollector } from '../core/segments'
import type { RawProfile, RawSegment } from '../core/segments'
import { buildDataset } from '../core/pipeline'
import { DEMO_FILE_NAME, generateDemoHistory } from '../demo/generate'

/**
 * 解析対象。通常はユーザーが選んだ File。
 * `url` は開発時だけ使う（dev サーバがリポジトリ内のファイルを配信できるため、
 * 手でファイル選択せずに動作確認できる）。本番ビルドでは呼ばれない。
 * `demo` は架空の人物の合成データ（DESIGN.md §8 C / src/demo/generate.ts）。
 * ファイルは読まずに Worker の中で生成し、実ファイルと同じ収集器と後段を通す。
 */
export type ParseSource =
  | { kind: 'file'; file: File }
  | { kind: 'url'; url: string; name: string }
  | { kind: 'demo'; seed: number }

type StreamSource = Exclude<ParseSource, { kind: 'demo' }>
type Collector = ReturnType<typeof createSegmentCollector>

/** 入力を収集器へ流し終えた時点の情報。ここから先（Dataset の組み立て）は入力の種類によらず共通 */
interface Ingested {
  fileName: string
  /** 読み飛ばした rawSignals の件数（収集器は通らないので入力側で数える） */
  rawSignalsDiscarded: number
  /** 進捗の分母。ファイルならバイト数、デモならセグメント数 */
  progressTotal: number
}

self.onmessage = async (
  ev: MessageEvent<{ source: ParseSource; fileHash: string; tripGapSec?: number }>,
) => {
  const { source, fileHash, tripGapSec } = ev.data
  try {
    const dataset = await parseSource(source, fileHash, tripGapSec)
    post({ type: 'done', dataset })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

function post(m: ParseMessage) {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(m)
}

async function openStream(
  source: StreamSource,
): Promise<{ stream: ReadableStream<Uint8Array>; size: number; name: string }> {
  if (source.kind === 'file') {
    return { stream: source.file.stream(), size: source.file.size, name: source.file.name }
  }
  const res = await fetch(source.url)
  if (!res.ok || !res.body) throw new Error(`取得に失敗しました: ${res.status}`)
  const len = Number(res.headers.get('content-length') ?? 0)
  return { stream: res.body, size: len, name: source.name }
}

async function parseSource(source: ParseSource, fileHash: string, tripGapSec?: number): Promise<Dataset> {
  const collector = createSegmentCollector()
  const { fileName, rawSignalsDiscarded, progressTotal } =
    source.kind === 'demo' ? ingestDemo(source.seed, collector) : await ingestStream(source, collector)

  const collected = collector.result()

  if (collected.counts.segments === 0) {
    // 形式違いのファイルを黙って「0 件」で開くと、利用者は原因が分からない。
    throw new Error(
      'このファイルには semanticSegments が見つかりませんでした。' +
        'Google マップアプリから書き出した新しい形式のタイムライン（location-history.json / タイムライン.json）を選んでください。' +
        'Google データエクスポート（Takeout）の古い形式（Records.json や「セマンティック ロケーション履歴」フォルダ）にはまだ対応していません。',
    )
  }

  return buildDataset({
    collected,
    tripGapSec,
    fileHash,
    fileName,
    rawSignalsDiscarded,
    parsedAt: Math.floor(Date.now() / 1000),
    onPhase: (phase) => post({ type: 'progress', phase, bytesRead: progressTotal, bytesTotal: progressTotal }),
  })
}

/**
 * 合成データを生成して収集器へ流す。生成結果はすでにオブジェクトなので、
 * JSON 文字列を経由せずにそのまま渡す（形式は Google の生の JSON と同じ）。
 */
function ingestDemo(seed: number, collector: Collector): Ingested {
  post({ type: 'progress', phase: 'デモデータを生成中', bytesRead: 0, bytesTotal: 1 })
  const history = generateDemoHistory(seed)
  const segments = history.semanticSegments
  const total = segments.length
  let lastPost = 0
  for (let i = 0; i < total; i++) {
    collector.ingestSegment(segments[i])
    const now = Date.now()
    if (now - lastPost > 120) {
      lastPost = now
      post({ type: 'progress', phase: 'デモデータを読み込み中', bytesRead: i + 1, bytesTotal: total })
    }
  }
  collector.ingestProfile(history.userLocationProfile)
  // rawSignals は合成していない（理由は src/demo/generate.ts の冒頭）
  return { fileName: DEMO_FILE_NAME, rawSignalsDiscarded: 0, progressTotal: total }
}

async function ingestStream(source: StreamSource, collector: Collector): Promise<Ingested> {
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

  return { fileName, rawSignalsDiscarded, progressTotal: total }
}
