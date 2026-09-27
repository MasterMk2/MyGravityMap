/**
 * 記録側のタイムゾーンを時刻から引く。
 *
 * Trip（軌跡）は点ごとの TZ を持たない。暦日や時間帯で軌跡を数えるときに
 * ブラウザのローカル時刻や UTC を使うと、海外滞在分が別の日・別の時間帯にずれる
 * （DESIGN.md §1.3）。取り込み時に全セグメントから拾った切り替わり点
 * （Dataset.tzChanges）を二分探索して、その時刻に有効だったオフセットを返す。
 */
import type { Seconds } from './types'

/** 切り替わり点が 1 つも無いときの既定。実データはほぼ国内なので JST に倒す */
export const FALLBACK_TZ_MIN = 540

export type TzLookup = (t: Seconds) => number

/**
 * tzChanges（時刻昇順）から、時刻 → UTC オフセット（分）の関数を作る。
 * 最初の切り替わり点より前の時刻には、最初の点のオフセットを返す。
 */
export function createTzLookup(tzChanges: Array<[Seconds, number]>): TzLookup {
  if (tzChanges.length === 0) return () => FALLBACK_TZ_MIN
  const times = tzChanges.map((c) => c[0])
  const tzs = tzChanges.map((c) => c[1])
  return (t) => {
    if (t < times[0]!) return tzs[0]!
    // t 以下で最後の切り替わり点
    let lo = 0
    let hi = times.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (times[mid]! <= t) lo = mid
      else hi = mid - 1
    }
    return tzs[lo]!
  }
}

/**
 * 記録側の暦日 'YYYY-MM-DD' の [開始, 終了) を絶対 Unix 秒で返す。
 * カレンダーで日を選んで再生期間にするときなどに使う。
 */
export function localDayRange(dayKey: string, tzOffsetMin: number): [Seconds, Seconds] {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number]
  const start = Date.UTC(y, m - 1, d) / 1000 - tzOffsetMin * 60
  return [start, start + 86400]
}
