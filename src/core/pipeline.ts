/**
 * 正規化済みのセグメント（CollectedSegments）から Dataset を組み立てる後段処理。
 *
 * 以前は Worker の中に直接書いてあった。ファイル以外の入力（デモ用の合成データなど）も
 * まったく同じ組み立て方を通すために切り出した。読み方が入力ごとに分かれると、
 * 「デモでは動くのに実データでは壊れる」が起きる。純関数・副作用なし。
 */
import type { Dataset, ParseStats } from './types'
import type { CollectedSegments } from './segments'
import { assignModes, buildTrips } from './trips'
import { aggregatePlaces, computeCoverage } from './aggregate'
import { deriveVisitsFromTrips } from './visits'
import { createTzLookup } from './timezone'
import { DEFAULT_TRIP_GAP_SEC, validateTripGapSec } from './importSettings'

export interface BuildDatasetInput {
  tripGapSec?: number
  collected: CollectedSegments
  fileHash: string
  fileName: string
  /** 読み飛ばした rawSignals の件数（収集器は通らないので呼び出し側が数える） */
  rawSignalsDiscarded: number
  /** 解析時刻（Unix 秒）。テストで固定できるように外から渡す */
  parsedAt: number
  /** 段階が進むたびに呼ばれる。進捗表示用 */
  onPhase?: (phase: string) => void
}

export function buildDataset(input: BuildDatasetInput): Dataset {
  const { collected, fileHash, fileName, rawSignalsDiscarded, parsedAt, onPhase } = input
  const { points, visits, moves, anchors, pathBuckets, visitYears, tzChanges, counts } = collected

  onPhase?.('軌跡を組み立て中')

  const gapSec = validateTripGapSec(input.tripGapSec ?? DEFAULT_TRIP_GAP_SEC)
  const built = buildTrips(points, { gapSec })
  const trips = assignModes(built.trips, moves)

  const stats: ParseStats = {
    ...counts,
    rawSignalsDiscarded,
    duplicateTimeFixed: built.duplicateTimeFixed,
    flightPointsInserted: built.flightPointsInserted,
  }

  onPhase?.('場所を集計中')

  // coverage は Google の訪問データが無い年を判定するために使うので、
  // 訪問の復元（deriveVisitsFromTrips）より先に求めておく必要がある。
  const coverage = computeCoverage({ pathBuckets, visitYears })
  // 復元した滞在は TZ を持たずに作られる（軌跡の点に TZ が無いため）。そのままだと
  // 暦日・時間帯が UTC で数えられ、再生中の時計も UTC になるので、記録側の TZ を入れ直す。
  const tzOf = createTzLookup(tzChanges)
  const derivedVisits = deriveVisitsFromTrips(trips, visits, coverage).map((v) => ({
    ...v,
    tzOffsetMin: tzOf(v.start),
  }))
  const allVisits = [...visits, ...derivedVisits]
  const { places } = aggregatePlaces(allVisits)

  // Math.min(...arr) は要素数が多いと引数上限で落ちるので、ループで取る
  let tMin = Infinity
  let tMax = -Infinity
  for (const t of trips) {
    if (t.tStart < tMin) tMin = t.tStart
    if (t.tEnd > tMax) tMax = t.tEnd
  }
  for (const v of allVisits) {
    if (v.start < tMin) tMin = v.start
    if (v.end > tMax) tMax = v.end
  }
  for (const m of moves) {
    if (m.start < tMin) tMin = m.start
    if (m.end > tMax) tMax = m.end
  }

  return {
    fileHash,
    fileName,
    parsedAt,
    tMin: Number.isFinite(tMin) ? tMin : 0,
    tMax: Number.isFinite(tMax) ? tMax : 0,
    trips,
    visits: allVisits,
    moves,
    places,
    coverage,
    anchors,
    tzChanges,
    stats,
  }
}
