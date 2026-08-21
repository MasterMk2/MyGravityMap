/**
 * Google の訪問データが存在しない年（YearCoverage.hasGoogleVisits === false）について、
 * GPS軌跡（Trip[]）だけから「その場に留まっていた」区間を検出し、Visit[] として復元する。
 *
 * 純粋関数・副作用なし。地図やUIへの組み込みは本ファイルの範囲外。
 */
import type { Trip, Visit, YearCoverage } from './types'

/** minDwellSec を省略した場合の既定（時間）。数時間単位の隙間を検出できる値。 */
const DEFAULT_MIN_DWELL_SEC = 3600

/**
 * trips[i] の終わりから trips[i+1] の始まりまでの「隙間」だけを対象に滞在区間を検出し、
 * Visit[] として復元する。
 *
 * 契約:
 * - trips 配列の外側（先頭より前・末尾後ろ）は window が無いので対象外。
 * - 隙間の長さが minDwellSec 未満なら対象外。
 * - 隙間の開始時刻（UTC）の暦年で coverage の hasGoogleVisits === true なら対象外。
 *   該当する YearCoverage が見つからない年も対象外（安全側に倒す）。
 * - 隙間が既存の visit（google 由来を含む）と時間的に重なれば対象外。
 * - 生成する Visit は source: 'derived', durationReliable: false, semanticType: 'UNKNOWN'、
 *   placeId は付けない。座標は「隙間の直前のトリップ」の最後の点を使う。
 * - 結果は時系列順（start 昇順）で返す。
 */
export function deriveVisitsFromTrips(
  trips: Trip[],
  existingVisits: Visit[],
  coverage: YearCoverage[],
  minDwellSec?: number,
): Visit[] {
  const minSec = minDwellSec ?? DEFAULT_MIN_DWELL_SEC
  const result: Visit[] = []

  for (let i = 0; i < trips.length - 1; i++) {
    // 隙間は trips[i] と trips[i+1] の間だけ。先頭の前・末尾の後ろは対象外。
    const gapStart = trips[i].tEnd
    const gapEnd = trips[i + 1].tStart

    // 長さゼロ以下の隙間は除外。
    if (gapEnd <= gapStart) continue
    // minDwellSec 未満の短い隙間は除外。
    if (gapEnd - gapStart < minSec) continue

    // 隙間開始時刻のUTC暦年で coverage を探す。無い年・Google データ既有の年は除外。
    const year = new Date(gapStart * 1000).getUTCFullYear()
    const cov = coverage.find((c) => c.year === year)
    if (!cov || cov.hasGoogleVisits) continue

    // 既存 visit と時間重なるなら除外（年に関わらず）。
    const overlaps = existingVisits.some(
      (v) => gapStart < v.end && v.start < gapEnd,
    )
    if (overlaps) continue

    // 隙間の直前のトリップ（trips[i]）の最後の点の座標を使う。
    const lastIdx = trips[i].times.length - 1
    const lat = trips[i].coords[lastIdx * 2 + 1]
    const lon = trips[i].coords[lastIdx * 2]

    result.push({
      start: gapStart,
      end: gapEnd,
      tzOffsetMin: 0,
      lat,
      lon,
      semanticType: 'UNKNOWN',
      hierarchyLevel: 0,
      // Google の visit.probability のような推定確度が無いので中立値にする
      // （0 だと「起きなかった」寄りに読めてしまうため 0.5 の方が実態に合う）。
      probability: 0.5,
      source: 'derived',
      durationReliable: false,
    })
  }

  // 時系列順（start 昇順）にソートして返す。
  result.sort((a, b) => a.start - b.start)
  return result
}
