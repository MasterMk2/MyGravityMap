/**
 * Google の訪問データが存在しない年（YearCoverage.hasGoogleVisits === false）について、
 * GPS軌跡（Trip[]）だけから「その場に留まっていた」区間を検出し、Visit[] として復元する。
 *
 * 純粋関数・副作用なし。地図やUIへの組み込みは本ファイルの範囲外。
 */
import type { Trip, Visit, YearCoverage } from './types'
import { haversineMeters } from './geo'

/** minDwellSec を省略した場合の既定（時間）。数時間単位の隙間を検出できる値。 */
const DEFAULT_MIN_DWELL_SEC = 3600

/**
 * 隙間の前後で許容する移動距離（メートル）。DESIGN.md §4.1-3 の R = 120m。
 *
 * 時間の隙間には 2 種類ある。「その場に留まっていて記録が途切れた」隙間と、
 * 「移動中に記録が落ちた」隙間（電池切れ・機内・地下）で、後者を滞在として
 * 拾うと、実際には通過しただけの地点に数時間の滞在が生える。
 * 隙間の前後の点が離れていれば後者と判断できる。
 *
 * 場所集約のグリッドが 100m なので、これより離れた 2 点はどのみち別の場所として
 * 数えられる。R をそれと同程度に取っておけば、判定と集約の粒度が食い違わない。
 */
const DEFAULT_MAX_MOVE_METERS = 120

/**
 * trips[i] の終わりから trips[i+1] の始まりまでの「隙間」だけを対象に滞在区間を検出し、
 * Visit[] として復元する。
 *
 * 契約:
 * - trips 配列の外側（先頭より前・末尾後ろ）は window が無いので対象外。
 * - 隙間の長さが minDwellSec 未満なら対象外。
 * - 隙間の前後の点（trips[i] の最後の点と trips[i+1] の最初の点）が
 *   maxMoveMeters より離れていれば対象外（＝移動中に記録が落ちた隙間）。
 * - 隙間の開始時刻（UTC）の暦年で coverage の hasGoogleVisits === true なら対象外。
 *   該当する YearCoverage が見つからない年も対象外（安全側に倒す）。
 * - 隙間が既存の visit（google 由来を含む）と時間的に重なれば対象外。
 * - 生成する Visit は source: 'derived', durationReliable: false, semanticType: 'UNKNOWN'、
 *   placeId は付けない。座標は「隙間の直前のトリップ」の最後の点を使う。
 * - 結果は時系列順（start 昇順）で返す。
 *
 * 限界: 出かけて戻ってくるまで記録が丸ごと落ちた場合、前後の点は近いので
 * 「ずっと居た」と判定される。この向きの誤りは軌跡データからは原理的に見分けられない。
 */
export function deriveVisitsFromTrips(
  trips: Trip[],
  existingVisits: Visit[],
  coverage: YearCoverage[],
  minDwellSec?: number,
  maxMoveMeters?: number,
): Visit[] {
  const minSec = minDwellSec ?? DEFAULT_MIN_DWELL_SEC
  const maxMeters = maxMoveMeters ?? DEFAULT_MAX_MOVE_METERS
  const result: Visit[] = []

  for (let i = 0; i < trips.length - 1; i++) {
    // 隙間は trips[i] と trips[i+1] の間だけ。先頭の前・末尾の後ろは対象外。
    const gapStart = trips[i].tEnd
    const gapEnd = trips[i + 1].tStart

    // 長さゼロ以下の隙間は除外。
    if (gapEnd <= gapStart) continue
    // minDwellSec 未満の短い隙間は除外。
    if (gapEnd - gapStart < minSec) continue

    // 隙間の直前のトリップ（trips[i]）の最後の点の座標を使う。
    const lastIdx = trips[i].times.length - 1
    const lat = trips[i].coords[lastIdx * 2 + 1]
    const lon = trips[i].coords[lastIdx * 2]

    // 隙間の前後で場所が動いていれば、留まっていたのではなく移動中に記録が落ちた隙間。
    // coords は times と同じ並び（buildTrips が時刻順に詰める）なので、
    // 先頭の座標がそのトリップの再開地点（tStart の点）になる。
    const nextLat = trips[i + 1].coords[1]
    const nextLon = trips[i + 1].coords[0]
    if (haversineMeters(lat, lon, nextLat, nextLon) > maxMeters) continue

    // 隙間開始時刻のUTC暦年で coverage を探す。無い年・Google データ既有の年は除外。
    const year = new Date(gapStart * 1000).getUTCFullYear()
    const cov = coverage.find((c) => c.year === year)
    if (!cov || cov.hasGoogleVisits) continue

    // 既存 visit と時間重なるなら除外（年に関わらず）。
    const overlaps = existingVisits.some(
      (v) => gapStart < v.end && v.start < gapEnd,
    )
    if (overlaps) continue

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
