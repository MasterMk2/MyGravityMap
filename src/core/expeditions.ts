/**
 * 遠征 / 旅行の抽出（DESIGN.md §2「脱出」、§5 ビュー #7）。
 *
 * 「その年の拠点（自宅など）から minKm より遠くに在圏があった日」を遠出の日とし、
 * 連続する遠出の日を 1 件の遠征にまとめる。在圏＝（1km 格子, 記録側の暦日）なので
 * 記録の濃さに左右されにくく、Google の visit が無い 2024 年より前にも使える
 * （在圏の定義と拠点の求め方は core/barycenter.ts）。
 *
 * 地名はデータに無い（§1.3）。場所の代わりに拠点からの距離と方角を返す。
 */
import type { Seconds } from './types'
import { haversineMeters } from './geo'
import { localDayRange } from './timezone'
import {
  collectPresences,
  dayNumberToKey,
  yearAnchors,
  type Anchor,
  type PresenceSource,
  type Presences,
} from './barycenter'

export interface Expedition {
  /** 最初の日の 0 時（記録側 TZ）。絶対 Unix 秒 */
  start: Seconds
  /** 最後の日の翌 0 時（記録側 TZ）。絶対 Unix 秒 */
  end: Seconds
  /** 暦日の数（間に挟んだ記録の無い日も含む） */
  days: number
  /** 拠点から最も遠かった在圏までの距離（km） */
  maxKm: number
  farthest: { lat: number; lon: number }
  /**
   * 遠出の在圏（拠点から minKm 超）を囲む範囲 [west, south, east, north]。
   * 日付変更線をまたぐときは east が 180 を超える（MapLibre の fitBounds はそのまま受け付ける）。
   * 1 点しか無くても地図が最大まで寄らないよう、最小の広さを確保してある。
   */
  bbox: [number, number, number, number]
  /** 期間内に飛行機（大圏補間の区間）があった */
  hasFlight: boolean
  /** 'YYYY-MM-DD'（記録側 TZ） */
  startDay: string
  endDay: string
  /** 距離と方角の基準にした拠点（最も遠い在圏に最も近い拠点） */
  home: { lat: number; lon: number }
}

export interface FindExpeditionsOptions {
  /** 拠点からこれより遠い在圏がある日を遠出とする（既定 50km） */
  minKm?: number
}

const DEFAULT_MIN_KM = 50

/**
 * 1 日だけ記録の途切れた日を挟んでも、その日に「家の近く」の在圏が無ければ同じ遠征とみなす。
 * 家の近く＝拠点から NEAR_HOME_KM 以内。2019 年ごろは 1 日 6 時間分しか記録が無く、
 * 旅行の中日がまるごと空くことがよくあるため。
 */
const NEAR_HOME_KM = 10

/** bbox の最小の広さ（度）。約 9km 四方 */
const MIN_BBOX_SPAN_DEG = 0.08

/** 1 日ぶんの要約。しきい値に依らないので一度だけ作って使い回す */
interface DaySummary {
  day: number
  /** Presences 上の範囲 [from, to) */
  from: number
  to: number
  /** その日の在圏のうち、最寄りの拠点から最も遠いものの距離（km） */
  maxKm: number
  /** 同じく最も近いものの距離（km） */
  minKm: number
}

interface ExpeditionBase {
  presences: Presences
  /** 在圏ごとの「最寄りの拠点までの距離」（km） */
  distKm: Float64Array
  /** 在圏ごとの最寄りの拠点 */
  anchorOf: Anchor[]
  days: DaySummary[]
  /** 日番号 → days の添字 */
  dayIndex: Map<number, number>
}

const baseCache = new WeakMap<Presences, ExpeditionBase>()

function buildBase(p: Presences): ExpeditionBase {
  const cached = baseCache.get(p)
  if (cached) return cached

  const anchorsByYear = yearAnchors(p)
  const distKm = new Float64Array(p.count)
  const anchorOf = new Array<Anchor>(p.count)
  const days: DaySummary[] = []
  const dayIndex = new Map<number, number>()

  for (const ya of anchorsByYear.values()) {
    for (let i = ya.from; i < ya.to; i++) {
      // 拠点は年に数か所しか無いので総当たりで十分
      let best = Infinity
      let bestAnchor = ya.home
      for (const a of ya.anchors) {
        const km = haversineMeters(a.lat, a.lon, p.lat[i]!, p.lon[i]!) / 1000
        if (km < best) {
          best = km
          bestAnchor = a
        }
      }
      distKm[i] = best
      anchorOf[i] = bestAnchor
    }
  }

  let from = 0
  while (from < p.count) {
    const day = p.day[from]!
    let to = from
    let maxKm = 0
    let minKm = Infinity
    while (to < p.count && p.day[to] === day) {
      const km = distKm[to]!
      if (km > maxKm) maxKm = km
      if (km < minKm) minKm = km
      to++
    }
    dayIndex.set(day, days.length)
    days.push({ day, from, to, maxKm, minKm })
    from = to
  }

  const base: ExpeditionBase = { presences: p, distKm, anchorOf, days, dayIndex }
  baseCache.set(p, base)
  return base
}

/**
 * 在圏の経度の広がりを、日付変更線をまたぐ場合も考えて最小の区間で返す。
 * 素直な [min, max] と、負の経度に 360 を足した [min, max] のうち狭い方を採る。
 */
function lonSpan(lons: number[]): [number, number] {
  let w1 = Infinity
  let e1 = -Infinity
  let w2 = Infinity
  let e2 = -Infinity
  for (const lon of lons) {
    if (lon < w1) w1 = lon
    if (lon > e1) e1 = lon
    const shifted = lon < 0 ? lon + 360 : lon
    if (shifted < w2) w2 = shifted
    if (shifted > e2) e2 = shifted
  }
  // 狭い方を採るのは経度が正負に割れているときだけで、そのとき w2 は正の側の最小値
  // （180 未満）になる。east だけが 180 を超え、区間の向きが保たれる
  if (e2 - w2 < e1 - w1) return [w2, e2]
  return [w1, e1]
}

function padSpan(lo: number, hi: number, min: number): [number, number] {
  const span = hi - lo
  if (span >= min) return [lo, hi]
  const pad = (min - span) / 2
  return [lo - pad, hi + pad]
}

/**
 * 遠征を抽出する。新しい順に並べて返す。
 *
 * - 遠出の日: その日の在圏のどれかが、その年の拠点（最寄りのもの）から minKm より遠い。
 * - 連続する遠出の日は 1 件にまとめる。
 * - 1 日だけ間が空いたときは、その日に家の近く（NEAR_HOME_KM 以内）の在圏が無ければつなぐ。
 *   記録が丸 1 日無い日や、遠出のしきい値には届かないが家には戻っていない日がこれに当たる。
 *   2 日以上空いたら別の遠征とする（戻っていたかどうか判断できないので、控えめに切る）。
 *
 * しきい値に依らない前処理（拠点までの距離・日ごとの要約）はキャッシュするので、
 * しきい値を切り替えるたびの計算は日数に比例する程度で済む。
 */
export function findExpeditions(
  source: PresenceSource,
  opts?: FindExpeditionsOptions,
): Expedition[] {
  const minKm = opts?.minKm ?? DEFAULT_MIN_KM
  const nearHomeKm = Math.min(NEAR_HOME_KM, minKm)
  const p = collectPresences(source)
  if (p.count === 0) return []
  const base = buildBase(p)
  const { days, dayIndex } = base

  // 遠出の日を、つなげられるものはつないで [最初の日, 最後の日] の組にする
  const groups: Array<[number, number]> = []
  for (const d of days) {
    if (d.maxKm <= minKm) continue
    const last = groups[groups.length - 1]
    if (last && d.day === last[1] + 1) {
      last[1] = d.day
      continue
    }
    if (last && d.day === last[1] + 2) {
      const gapAt = dayIndex.get(last[1] + 1)
      const gap = gapAt === undefined ? undefined : days[gapAt]
      if (!gap || gap.minKm > nearHomeKm) {
        last[1] = d.day
        continue
      }
    }
    groups.push([d.day, d.day])
  }

  const out: Expedition[] = []
  for (const [first, last] of groups) {
    out.push(summarize(base, first, last, minKm))
  }
  out.sort((a, b) => b.start - a.start)
  return out
}

function summarize(base: ExpeditionBase, first: number, last: number, minKm: number): Expedition {
  const { presences: p, distKm, anchorOf, days, dayIndex } = base
  let maxKm = -1
  let far = -1
  let south = Infinity
  let north = -Infinity
  const lons: number[] = []

  for (let day = first; day <= last; day++) {
    const at = dayIndex.get(day)
    if (at === undefined) continue
    const d = days[at]!
    for (let i = d.from; i < d.to; i++) {
      const km = distKm[i]!
      // 範囲は遠出の在圏だけで取る。出発日の自宅まで含めると、
      // 行き先ではなく「自宅から行き先まで」を映すことになり、どこへ行ったかが小さくなる
      if (km <= minKm) continue
      if (km > maxKm) {
        maxKm = km
        far = i
      }
      const lat = p.lat[i]!
      if (lat < south) south = lat
      if (lat > north) north = lat
      lons.push(p.lon[i]!)
    }
  }

  // groups は遠出の日から作るので、少なくとも 1 件は minKm 超の在圏がある
  const [w, e] = lonSpan(lons)
  const [s2, n2] = padSpan(south, north, MIN_BBOX_SPAN_DEG)
  const midLat = ((s2 + n2) / 2) * (Math.PI / 180)
  const [w2, e2] = padSpan(w, e, MIN_BBOX_SPAN_DEG / Math.max(0.1, Math.cos(midLat)))

  const firstTz = p.dayStartTz.get(first) ?? 0
  const lastTz = p.dayEndTz.get(last) ?? firstTz
  const startDay = dayNumberToKey(first)
  const endDay = dayNumberToKey(last)

  let hasFlight = false
  for (let day = first; day <= last && !hasFlight; day++) {
    if (p.flightDays.has(day)) hasFlight = true
  }

  const home = anchorOf[far]!
  return {
    start: localDayRange(startDay, firstTz)[0],
    end: localDayRange(endDay, lastTz)[1],
    days: last - first + 1,
    maxKm,
    farthest: { lat: p.lat[far]!, lon: p.lon[far]! },
    bbox: [w2, Math.max(-90, s2), e2, Math.min(90, n2)],
    hasFlight,
    startDay,
    endDay,
    home: { lat: home.lat, lon: home.lon },
  }
}

/** 遠征の開始日の年（一覧を年ごとにまとめるため） */
export function expeditionYear(e: Expedition): number {
  return Number(e.startDay.slice(0, 4))
}
