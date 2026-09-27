/**
 * 統計ビュー・カレンダービュー用の集計。純関数・副作用なし。
 *
 * 前提（DESIGN.md §1.2.1）: 年ごとに「記録の濃さ」が違う（2019 年は 1 日 6 時間ぶん、
 * 2025 年は 15 時間ぶん）。ここで出す合計値は「記録された範囲の合計」であって、
 * 生活そのものの量ではない。UI 側は必ずその注意書きと一緒に出すこと。
 *
 * 暦日・時間帯・曜日は必ず記録側のタイムゾーンで数える（DESIGN.md §1.3）。
 * Trip は TZ を持たないので、Dataset.tzChanges から作った TzLookup で時刻ごとに引く。
 *
 * 軌跡の点ごとに Date を作ると 12 万点 × 数回で重くなるので、
 * 「UTC 秒 + オフセット」を 86400 / 3600 で割った通し番号で暦日・時を数える。
 * geo.ts の localDayKey / localHour / localWeekday と同じ結果になる（テストで確認）。
 */
import type { Dataset, Move, Place, Seconds, TimeWindow, TravelMode, Trip, Visit } from './types'
import { haversineMeters, localDayKey } from './geo'
import { createTzLookup, type TzLookup } from './timezone'

/**
 * 飛行とみなす区間の長さ（m）。isFlight のトリップの中でこれより長い点対は、
 * 大圏補間で埋めた区間（または補間の元になった長距離の跳び）なので「地上の移動距離」に入れない。
 * 空港までの徒歩や車の点対は数分おきで 2km に届かないことが多い、という割り切り。
 */
export const FLIGHT_SEGMENT_MIN_METERS = 2000

/**
 * 点対の速度がこれ以上なら「移動中」、未満なら「停止中」として時間を数える。
 * GPS のぶれ（数十 m / 数分 ≒ 1 km/h 未満）は拾わず、ゆっくり歩く速さは拾う境目。
 */
export const MOVING_MIN_KMH = 3

/**
 * 1 つの点対が表せる最大の秒数。gravity/weights.ts の MAX_SECONDS_PER_POINT と同じ理由
 * （記録が飛んだ区間を「ずっと記録していた」と数えない）で、軌跡の分割閾値 30 分に揃える。
 * buildTrips が 30 分で分割するのでトリップ内では通常超えないが、入力を信用しない。
 */
export const MAX_SECONDS_PER_SEGMENT = 1800

const DAY = 86400
const HOUR = 3600
/** 1970-01-01（通し番号 0 の日）は木曜 */
const EPOCH_WEEKDAY = 4

function mod(a: number, n: number): number {
  return ((a % n) + n) % n
}

/** 現地の日の通し番号 → 'YYYY-MM-DD'。localDayKey にオフセット 0 で通すと同じ書式になる */
function dayIndexToKey(dayIndex: number): string {
  return localDayKey(dayIndex * DAY, 0)
}

function dayIndexToYear(dayIndex: number): number {
  return new Date(dayIndex * DAY * 1000).getUTCFullYear()
}

/**
 * 絶対時刻の区間 [a, b) を、記録側の時刻で unitSec ごとの枠（日・時）に切って渡す。
 * 枠番号は「現地時刻の 1970-01-01 0 時からの通し番号」。
 * オフセットは区間の始点のものを使う（区間は最長 30 分なので、途中で TZ が変わる誤差は小さい）。
 */
function splitLocal(
  a: Seconds,
  b: Seconds,
  tzMin: number,
  unitSec: number,
  cb: (unit: number, sec: number) => void,
): void {
  const off = tzMin * 60
  let la = a + off
  const lb = b + off
  while (la < lb) {
    const unit = Math.floor(la / unitSec)
    const next = Math.min(lb, (unit + 1) * unitSec)
    cb(unit, next - la)
    la = next
  }
}

/** 点対（期間で切り詰め済み）。時間系の集計と距離系の集計で共有する */
interface Segment {
  /** 期間で切り詰めた始点・終点（絶対秒） */
  t0: Seconds
  t1: Seconds
  /** 切り詰め後の距離（m）。元の点対の距離を時間の割合で按分したもの */
  meters: number
  /** 飛行区間（補間）か */
  flight: boolean
  /** 元の点対の平均速度（km/h）。移動中／停止中の判定に使う */
  kmh: number
  /**
   * 時間を数えるときに掛ける割合。元の点対が 30 分を超えるときだけ 1 未満になる
   * （上限を超えた分を「記録されていた時間」に入れない）
   */
  timeShare: number
  /** 始点の UTC オフセット（分） */
  tz: number
}

/**
 * 期間に掛かる点対を順に渡す。点対が期間の端をまたぐときは、時間の割合で距離を按分する
 * （1 日だけを選んだときに、前日から続く区間の距離を丸ごと入れないため）。
 * w が null なら全期間。期間は [start, end) として扱う。
 */
function forEachSegment(
  trips: Trip[],
  w: TimeWindow | null,
  tzOf: TzLookup,
  cb: (s: Segment) => void,
): void {
  for (const trip of trips) {
    if (w && (trip.tEnd <= w.start || trip.tStart >= w.end)) continue
    const { times, coords } = trip
    for (let i = 0; i + 1 < times.length; i++) {
      const a = times[i]!
      const b = times[i + 1]!
      if (b <= a) continue
      const t0 = w ? Math.max(a, w.start) : a
      const t1 = w ? Math.min(b, w.end) : b
      if (t1 <= t0) continue
      const full = haversineMeters(coords[i * 2 + 1]!, coords[i * 2]!, coords[i * 2 + 3]!, coords[i * 2 + 2]!)
      const fullSec = b - a
      cb({
        t0,
        t1,
        meters: (full * (t1 - t0)) / fullSec,
        flight: trip.isFlight && full > FLIGHT_SEGMENT_MIN_METERS,
        kmh: full / 1000 / (fullSec / 3600),
        timeShare: fullSec > MAX_SECONDS_PER_SEGMENT ? MAX_SECONDS_PER_SEGMENT / fullSec : 1,
        tz: tzOf(a),
      })
    }
  }
}

/** 訪問の記録側オフセット。derived の訪問は tzOffsetMin を 0 で作っているので時刻から引き直す */
function visitTz(v: Visit, tzOf: TzLookup): number {
  return v.source === 'derived' ? tzOf(v.start) : v.tzOffsetMin
}

/** 年 → 値 の Map を、最小〜最大の年を隙間なく並べた配列にする（棒の抜けを「0」と読めるように） */
function fillYears<T>(byYear: Map<number, T>, empty: (year: number) => T): T[] {
  if (byYear.size === 0) return []
  const years = [...byYear.keys()]
  const lo = Math.min(...years)
  const hi = Math.max(...years)
  const out: T[] = []
  for (let y = lo; y <= hi; y++) out.push(byYear.get(y) ?? empty(y))
  return out
}

// ---------------------------------------------------------------------------
// 日ごとの集計（カレンダー）
// ---------------------------------------------------------------------------

export interface DayStat {
  /** 移動距離（km）。地上 + 飛行 */
  km: number
  /** km のうち飛行区間（補間）の距離 */
  flightKm: number
  /** 軌跡の記録時間（秒）。点対の間隔の合計（30 分上限・飛行の補間区間は除く） */
  recordedSec: number
  /** その日に始まった level 0 の訪問の数（derived を含む） */
  visits: number
  /** 軌跡の点の数（飛行の補間点は除く） */
  points: number
  /**
   * その日で最初に見つかった記録の UTC オフセット（分）。参考値。
   * その日のうちにオフセットが変わることがあるので、暦日を期間にするときは localDayWindow を使う
   */
  tz: number
}

/**
 * 記録側の暦日 'YYYY-MM-DD' ごとの集計。キーは日付順。何の記録も無い日はキー自体が無い。
 * データセット全体で 1 回だけ計算する想定（カレンダーが useMemo で保持する）。
 */
export function dailySummary(
  dataset: Pick<Dataset, 'trips' | 'visits' | 'tzChanges'>,
): Map<string, DayStat> {
  const tzOf = createTzLookup(dataset.tzChanges)
  const byIndex = new Map<number, DayStat>()
  const at = (dayIndex: number, tz: number): DayStat => {
    let d = byIndex.get(dayIndex)
    if (!d) {
      d = { km: 0, flightKm: 0, recordedSec: 0, visits: 0, points: 0, tz }
      byIndex.set(dayIndex, d)
    }
    return d
  }

  for (const trip of dataset.trips) {
    const { times, coords } = trip
    const n = times.length
    let prevFlight = false
    for (let i = 0; i < n; i++) {
      const t = times[i]!
      const tz = tzOf(t)
      let meters = 0
      let nextFlight = false
      if (i + 1 < n) {
        meters = haversineMeters(coords[i * 2 + 1]!, coords[i * 2]!, coords[i * 2 + 3]!, coords[i * 2 + 2]!)
        nextFlight = trip.isFlight && meters > FLIGHT_SEGMENT_MIN_METERS
      }
      // 前後とも飛行区間の点は大圏補間で挿入した点で、記録ではない
      if (!(prevFlight && nextFlight)) at(Math.floor((t + tz * 60) / DAY), tz).points += 1

      if (i + 1 < n) {
        const t1 = times[i + 1]!
        const full = t1 - t
        if (full > 0) {
          const share = full > MAX_SECONDS_PER_SEGMENT ? MAX_SECONDS_PER_SEGMENT / full : 1
          // 日付をまたぐ点対は時間の割合で両日に分ける（統計ビューの期間按分と数字を揃える）
          splitLocal(t, t1, tz, DAY, (dayIndex, sec) => {
            const d = at(dayIndex, tz)
            const km = (meters * sec) / full / 1000
            d.km += km
            if (nextFlight) d.flightKm += km
            else d.recordedSec += sec * share
          })
        }
      }
      prevFlight = nextFlight
    }
  }

  for (const v of dataset.visits) {
    // level 1 は level 0 と時間が重なる（DESIGN.md §1.3）ので数えない
    if (v.hierarchyLevel !== 0) continue
    const tz = visitTz(v, tzOf)
    at(Math.floor((v.start + tz * 60) / DAY), tz).visits += 1
  }

  const out = new Map<string, DayStat>()
  for (const idx of [...byIndex.keys()].sort((a, b) => a - b)) {
    out.set(dayIndexToKey(idx), byIndex.get(idx)!)
  }
  return out
}

// ---------------------------------------------------------------------------
// 期間内の集計（統計ビュー）
// ---------------------------------------------------------------------------

export interface YearDistance {
  year: number
  /** 地上の移動距離（km） */
  groundKm: number
  /** 飛行区間（補間）の距離（km） */
  flightKm: number
}

/** 期間内の移動距離を記録側の暦年ごとに。年は昇順・距離が 0 の年も間を埋めて返す */
export function distanceByYear(trips: Trip[], w: TimeWindow, tzOf: TzLookup): YearDistance[] {
  const byYear = new Map<number, YearDistance>()
  const yearOf = new Map<number, number>()
  forEachSegment(trips, w, tzOf, (s) => {
    splitLocal(s.t0, s.t1, s.tz, DAY, (dayIndex, sec) => {
      let year = yearOf.get(dayIndex)
      if (year === undefined) yearOf.set(dayIndex, (year = dayIndexToYear(dayIndex)))
      let y = byYear.get(year)
      if (!y) byYear.set(year, (y = { year, groundKm: 0, flightKm: 0 }))
      const km = (s.meters * sec) / (s.t1 - s.t0) / 1000
      if (s.flight) y.flightKm += km
      else y.groundKm += km
    })
  })
  return fillYears(byYear, (year) => ({ year, groundKm: 0, flightKm: 0 }))
}

export interface ActivityProfile {
  /** 記録側の時（0-23）ごとの記録時間（秒）。移動中 */
  hourMovingSec: number[]
  /** 同じく停止中 */
  hourStillSec: number[]
  /** 曜日（0=日曜）ごとの記録時間（秒）。移動中 */
  weekdayMovingSec: number[]
  weekdayStillSec: number[]
  /** 曜日ごとの「記録のあった日」の数。合計を曜日の出現回数で読み違えないための参考値 */
  weekdayDays: number[]
}

/**
 * 時間帯・曜日のプロファイル。軌跡の点対の時間を、記録側の時刻で 1 時間／1 日ごとに切って数える。
 *
 * 点の「数」ではなく「時間」を数えるのは、点の間隔が年によって 4 倍近く違うため
 * （点で数えると記録の細かい年ほど重くなる）。点対の速度が MOVING_MIN_KMH 以上なら移動中。
 * 飛行の補間区間は記録ではないので含めない（51 時間を補間で埋めた便を「51 時間移動」と数えない）。
 */
export function activityProfile(trips: Trip[], w: TimeWindow, tzOf: TzLookup): ActivityProfile {
  const p: ActivityProfile = {
    hourMovingSec: new Array<number>(24).fill(0),
    hourStillSec: new Array<number>(24).fill(0),
    weekdayMovingSec: new Array<number>(7).fill(0),
    weekdayStillSec: new Array<number>(7).fill(0),
    weekdayDays: new Array<number>(7).fill(0),
  }
  const days = new Set<number>()
  forEachSegment(trips, w, tzOf, (s) => {
    if (s.flight) return
    const moving = s.kmh >= MOVING_MIN_KMH
    splitLocal(s.t0, s.t1, s.tz, HOUR, (hourIndex, sec) => {
      const h = mod(hourIndex, 24)
      if (moving) p.hourMovingSec[h] += sec * s.timeShare
      else p.hourStillSec[h] += sec * s.timeShare
    })
    splitLocal(s.t0, s.t1, s.tz, DAY, (dayIndex, sec) => {
      const wd = mod(dayIndex + EPOCH_WEEKDAY, 7)
      if (moving) p.weekdayMovingSec[wd] += sec * s.timeShare
      else p.weekdayStillSec[wd] += sec * s.timeShare
      if (!days.has(dayIndex)) {
        days.add(dayIndex)
        p.weekdayDays[wd] += 1
      }
    })
  })
  return p
}

export interface ModeStat {
  mode: TravelMode
  meters: number
  seconds: number
  /** 期間に掛かった移動区間の数 */
  count: number
}

/**
 * 交通手段ごとの距離・時間（Google の activity セグメント由来。2024 年秋以降にしか無い）。
 * 期間の端をまたぐ区間は時間の割合で按分する。距離の大きい順。
 */
export function modeBreakdown(moves: Move[], w: TimeWindow): ModeStat[] {
  const byMode = new Map<TravelMode, ModeStat>()
  for (const m of moves) {
    const t0 = Math.max(m.start, w.start)
    const t1 = Math.min(m.end, w.end)
    // 長さ 0 の区間（開始＝終了）も、期間内にあれば回数と距離だけは数える
    const inside = m.end > m.start ? t1 > t0 : m.start >= w.start && m.start < w.end
    if (!inside) continue
    const frac = m.end > m.start ? (t1 - t0) / (m.end - m.start) : 1
    let s = byMode.get(m.mode)
    if (!s) byMode.set(m.mode, (s = { mode: m.mode, meters: 0, seconds: 0, count: 0 }))
    s.meters += m.distanceMeters * frac
    s.seconds += Math.max(0, t1 - t0)
    s.count += 1
  }
  return [...byMode.values()].sort((a, b) => b.meters - a.meters || b.seconds - a.seconds)
}

export interface YearNewPlaces {
  year: number
  /** Google の訪問を含む場所 */
  google: number
  /** 軌跡から復元した訪問だけの場所（2024 年秋より前にしか無く、粗い） */
  derived: number
}

/**
 * 期間内に初めて訪れた場所の数を、記録側の暦年ごとに。
 * 「初めて」は全データを通しての firstSeen なので、期間より前に来たことのある場所は数えない。
 */
export function newPlacesByYear(places: Place[], w: TimeWindow, tzOf: TzLookup): YearNewPlaces[] {
  const byYear = new Map<number, YearNewPlaces>()
  for (const p of places) {
    if (p.firstSeen < w.start || p.firstSeen >= w.end) continue
    const year = Number(localDayKey(p.firstSeen, tzOf(p.firstSeen)).slice(0, 4))
    let y = byYear.get(year)
    if (!y) byYear.set(year, (y = { year, google: 0, derived: 0 }))
    if (p.sources.length > 0 && p.sources.every((s) => s === 'derived')) y.derived += 1
    else y.google += 1
  }
  return fillYears(byYear, (year) => ({ year, google: 0, derived: 0 }))
}

// ---------------------------------------------------------------------------
// 色の段階（カレンダー）
// ---------------------------------------------------------------------------

/**
 * 正の値だけから分位点を求める（既定は四分位 → 4 段階）。
 * 飛行機に乗った日のような極端な日があっても、線形の段階と違って他の日が最下段に潰れない。
 * 0 の日を混ぜないのは、「記録はあるが 0」の日を段階とは別の色で見せるため。
 */
export function quantileBreaks(values: Iterable<number>, qs: number[] = [0.25, 0.5, 0.75]): number[] {
  const pos: number[] = []
  for (const v of values) if (v > 0 && Number.isFinite(v)) pos.push(v)
  if (pos.length === 0) return []
  pos.sort((a, b) => a - b)
  return qs.map((q) => pos[Math.min(pos.length - 1, Math.max(0, Math.ceil(q * pos.length) - 1))]!)
}

/**
 * 値 → 段階。0 以下は 0（記録はあるが値が無い）、正の値は 1〜breaks.length + 1。
 * breaks が空（正の値が 1 つも無い）なら正の値はすべて最上段。
 */
export function levelOf(value: number, breaks: number[]): number {
  if (!(value > 0)) return 0
  let level = 1
  for (const b of breaks) {
    if (value > b) level += 1
    else break
  }
  return breaks.length === 0 ? 1 : level
}

// ---------------------------------------------------------------------------
// カレンダーの升目の配置
// ---------------------------------------------------------------------------

export interface GridCell {
  /** 'YYYY-MM-DD' */
  key: string
  /** 週の列（0 = その年の 1 月 1 日を含む週） */
  col: number
  /** 曜日の行（0 = 日曜） */
  row: number
}

export interface YearGrid {
  year: number
  cells: GridCell[]
  /** 列の数（53、年初が土曜の閏年だけ 54） */
  cols: number
  /** 各月 1 日の列（月の見出しの位置） */
  monthCols: number[]
}

/** GitHub の草と同じ並び（列＝週、行＝曜日・日曜が上）で、1 年ぶんの升目を並べる */
export function yearGrid(year: number): YearGrid {
  const jan1 = Date.UTC(year, 0, 1) / 1000
  const offset = new Date(jan1 * 1000).getUTCDay()
  const days = Math.round((Date.UTC(year + 1, 0, 1) / 1000 - jan1) / DAY)
  const cells: GridCell[] = []
  const monthCols: number[] = []
  for (let i = 0; i < days; i++) {
    const t = jan1 + i * DAY
    const key = localDayKey(t, 0)
    const col = Math.floor((i + offset) / 7)
    if (key.endsWith('-01')) monthCols.push(col)
    cells.push({ key, col, row: (i + offset) % 7 })
  }
  return { year, cells, cols: cells[cells.length - 1]!.col + 1, monthCols }
}

/**
 * 記録側の暦日 'YYYY-MM-DD' を絶対時刻の期間 [start, end) にする。
 *
 * localDayRange（オフセット 1 つ）では足りない: 海外へ飛んだ日のように、その日のうちに
 * オフセットが変わると、日の前半は +540・後半は +60 で数えられている。片方のオフセットで
 * 期間を作ると、カレンダーでは同じ日に数えた記録が統計ビューの期間から漏れる。
 * そこで「その日になり得る時刻（UTC−12 〜 UTC+14）」をオフセットが一定の区間に切り、
 * 各区間でその日に当たる部分を求めて、いちばん早い開始〜いちばん遅い終了を返す。
 */
export function localDayWindow(dayKey: string, tzChanges: Array<[Seconds, number]>): TimeWindow {
  const tzOf = createTzLookup(tzChanges)
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number]
  const midnightUtc = Date.UTC(y, m - 1, d) / 1000
  const lo = midnightUtc - 14 * HOUR
  const hi = midnightUtc + DAY + 12 * HOUR
  const cuts = [lo]
  for (const [t] of tzChanges) if (t > lo && t < hi) cuts.push(t)
  cuts.push(hi)
  let start = Infinity
  let end = -Infinity
  for (let i = 0; i + 1 < cuts.length; i++) {
    const z = tzOf(cuts[i]!)
    const s = Math.max(cuts[i]!, midnightUtc - z * 60)
    const e = Math.min(cuts[i + 1]!, midnightUtc + DAY - z * 60)
    if (s < e) {
      start = Math.min(start, s)
      end = Math.max(end, e)
    }
  }
  if (start === Infinity) {
    // 東へ大きく飛んでその日がまるごと飛ばされた場合（実際にはまず起きない）。昼の時点のオフセットで代用する
    const z = tzOf(midnightUtc + DAY / 2)
    return { start: midnightUtc - z * 60, end: midnightUtc + DAY - z * 60 }
  }
  return { start, end }
}

/** 'YYYY-MM-DD' の曜日（0=日曜）。暦日そのものの曜日なので TZ は関係ない */
export function weekdayOfKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

// ---------------------------------------------------------------------------
// 表示用の名前
// ---------------------------------------------------------------------------

export const MODE_LABELS: Record<TravelMode, string> = {
  IN_PASSENGER_VEHICLE: '自動車',
  WALKING: '徒歩',
  IN_TRAIN: '電車',
  IN_SUBWAY: '地下鉄',
  IN_TRAM: '路面電車',
  IN_BUS: 'バス',
  CYCLING: '自転車',
  MOTORCYCLING: 'バイク',
  RUNNING: 'ランニング',
  FLYING: '飛行機',
  UNKNOWN: '不明',
}

export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const
