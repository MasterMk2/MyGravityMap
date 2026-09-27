/**
 * 重心の変遷（DESIGN.md §2 重心 / 回転半径、§5 ビュー #6）と、その土台になる「在圏」。
 *
 * ■ 時間ではなく頻度で数える
 * 記録の濃さは年で 2 倍以上違う（2019 年は 1 日約 6 時間、2025 年は約 15 時間。§1.2.1）。
 * 点数や滞在秒数で重みを付けると、生活が変わったからではなく記録形式が変わったから
 * 近年が重くなる。そこで「在圏」＝（約 1km の格子, 記録側の暦日）の組を 1 単位とし、
 * 同じ日に同じ格子で何点記録されていても 1 回に丸める。
 * Google の visit は 2024 年秋以降にしか無いので、全期間で使える軌跡（dataset.trips）から作る。
 *
 * 純粋関数のみ。ただし在圏の抽出は 12 万点を一巡するので、同じ入力に対しては
 * 結果を使い回す（WeakMap のキャッシュ。重心と遠征の両方から呼ばれるため）。
 */
import type { Dataset, Seconds, Trip } from './types'
import { haversineMeters } from './geo'
import { createTzLookup } from './timezone'

/** 在圏の計算に必要なのはこの 2 つだけ。テストで Dataset 全体を組まなくて済むようにする */
export type PresenceSource = Pick<Dataset, 'trips' | 'tzChanges'>

/** 格子の一辺（緯度方向の度）。1° ≈ 111km なので約 1km */
export const CELL_DEG = 0.009

/**
 * 飛行トリップのうち、この距離を超える区間は「上空を通っただけ」とみなす。
 * gravity/weights.ts の FLIGHT_SEGMENT_MIN_METERS と同じ値・同じ考え方。
 */
const FLIGHT_SEGMENT_MIN_METERS = 2000

/**
 * 大圏補間の区間を「等間隔の並び」でも見分けるための下限。
 *
 * 2km 基準だけだと、記録が長く途切れた遅い長距離移動（例: 250km を 48 時間）を
 * 取りこぼす。補間は 600 秒ごとに点を入れるので、その場合の点間隔は 1km 未満になり、
 * 2km を下回ってしまう。すると海の上や他人の街に 300 近い「在圏」が並び、
 * 1 年ぶんの重心を目に見えて引っ張る。
 * 補間点は slerp で作るので、区間の長さが（浮動小数の誤差を除き）完全に等しく、
 * 時刻の刻みも丸め誤差の ±1 秒に収まる。実測の GPS 点がこれを 6 区間続けて
 * 満たすことはまず無いので、飛行トリップの中に限ってこの並びも補間とみなす。
 */
const SYNTHETIC_RUN_MIN_SEGMENTS = 6
const SYNTHETIC_MIN_SEGMENT_METERS = 50
const SYNTHETIC_REL_TOLERANCE = 1e-6

/** 在圏キー = 格子キー × この値 + 日番号。日番号は 2243 年まで 10 万未満に収まる */
const DAY_KEY_SPAN = 100000

/**
 * 在圏の一覧。日番号の昇順に並ぶ（同じ日の中の順序は不定）。
 * 型付き配列で持つのは、全期間で数万件になり、年ごと・日ごとに何度も走査するため。
 */
export interface Presences {
  count: number
  /** その日その格子で記録された点の平均座標（格子の中心ではなく実際の位置に寄せる） */
  lat: Float64Array
  lon: Float64Array
  /** 格子キー（cellKeyOf） */
  cell: Float64Array
  /** 記録側 TZ の暦日の通し番号（1970-01-01 = 0）。昇順 */
  day: Int32Array
  /**
   * 日番号 → その日の最初の点の UTC オフセット（分）。
   * 暦日を絶対時刻の範囲に戻すとき（localDayRange）に使う。海外へ飛んだ日は
   * 日の途中でオフセットが変わるので、始まりと終わりで別々に持つ。
   */
  dayStartTz: Map<number, number>
  /** 日番号 → その日の最後の点の UTC オフセット（分） */
  dayEndTz: Map<number, number>
  /** 大圏補間の区間を含んだ日（＝飛行機に乗った日） */
  flightDays: Set<number>
}

/** 約 1km の格子のキー。経度方向の幅は緯度に応じて広げ、どこでもほぼ正方形にする */
export function cellKeyOf(lat: number, lon: number): number {
  const row = Math.floor(lat / CELL_DEG)
  const rowLat = (row + 0.5) * CELL_DEG
  const lonStep = CELL_DEG / Math.max(0.01, Math.cos((rowLat * Math.PI) / 180))
  const col = Math.floor((lon + 180) / lonStep)
  return (row + 20000) * 100000 + col
}

/** 記録側 TZ での暦日の通し番号。geo.ts の localDayKey と同じ境界で日を切る */
export function localDayNumber(t: Seconds, tzOffsetMin: number): number {
  return Math.floor((t + tzOffsetMin * 60) / 86400)
}

/** 日番号 → 'YYYY-MM-DD' */
export function dayNumberToKey(day: number): string {
  const d = new Date(day * 86400000)
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${m}-${dd}`
}

/** 日番号 → 年（記録側 TZ の暦年） */
export function dayNumberToYear(day: number): number {
  return new Date(day * 86400000).getUTCFullYear()
}

/**
 * 飛行トリップの点のうち「実際には居なかった」点に 1 を立てる。
 *
 * 大圏補間の中間点は、前後どちらの区間も補間区間になっている。逆に補間の両端
 * （出発空港・到着空港で実際に記録された点）は片側が実測の区間なので残る。
 * トリップの最初と最後の点は必ず実測点（補間の刻みは 600 秒で分割閾値の 30 分より短く、
 * 補間の途中でトリップが切れることは無い）なので、除外の対象にしない。
 */
function bridgedPointMask(trip: Trip): Uint8Array | null {
  if (!trip.isFlight) return null
  const n = trip.times.length
  if (n < 3) return null
  const segs = n - 1
  const dist = new Float64Array(segs)
  const dt = new Float64Array(segs)
  const synthetic = new Uint8Array(segs)
  for (let i = 0; i < segs; i++) {
    dist[i] = haversineMeters(
      trip.coords[i * 2 + 1]!,
      trip.coords[i * 2]!,
      trip.coords[(i + 1) * 2 + 1]!,
      trip.coords[(i + 1) * 2]!,
    )
    dt[i] = trip.times[i + 1]! - trip.times[i]!
    if (dist[i]! > FLIGHT_SEGMENT_MIN_METERS) synthetic[i] = 1
  }

  // 等間隔の並び（遅い長距離移動の補間）を拾う
  let runStart = 0
  for (let i = 1; i <= segs; i++) {
    const continues =
      i < segs &&
      dist[i]! > SYNTHETIC_MIN_SEGMENT_METERS &&
      dist[i - 1]! > SYNTHETIC_MIN_SEGMENT_METERS &&
      Math.abs(dist[i]! - dist[i - 1]!) <= dist[i]! * SYNTHETIC_REL_TOLERANCE &&
      Math.abs(dt[i]! - dt[i - 1]!) <= 1
    if (continues) continue
    if (i - runStart >= SYNTHETIC_RUN_MIN_SEGMENTS) {
      for (let k = runStart; k < i; k++) synthetic[k] = 1
    }
    runStart = i
  }

  const mask = new Uint8Array(n)
  let any = false
  for (let k = 1; k < n - 1; k++) {
    if (synthetic[k - 1] && synthetic[k]) {
      mask[k] = 1
      any = true
    }
  }
  return any ? mask : null
}

const presenceCache = new WeakMap<Trip[], { tzChanges: Array<[Seconds, number]>; result: Presences }>()

/**
 * 軌跡から在圏を取り出す。全点を一巡するだけ（O(点数 × log TZ 切替数)）。
 * 大圏補間で挿入した点（bridgedPointMask）は「そこに居た」わけではないので数えない。
 */
export function collectPresences(source: PresenceSource): Presences {
  const cached = presenceCache.get(source.trips)
  if (cached && cached.tzChanges === source.tzChanges) return cached.result

  const tzOf = createTzLookup(source.tzChanges)
  const index = new Map<number, number>()
  const sumLat: number[] = []
  const sumLon: number[] = []
  const counts: number[] = []
  const cells: number[] = []
  const days: number[] = []
  // 日番号 → [最初の時刻, TZ, 最後の時刻, TZ]
  const dayBounds = new Map<number, [number, number, number, number]>()
  const flightDays = new Set<number>()

  for (const trip of source.trips) {
    const mask = bridgedPointMask(trip)
    const n = trip.times.length
    for (let i = 0; i < n; i++) {
      const t = trip.times[i]!
      const tz = tzOf(t)
      const day = localDayNumber(t, tz)
      if (mask && mask[i]) {
        flightDays.add(day)
        continue
      }
      const lon = trip.coords[i * 2]!
      const lat = trip.coords[i * 2 + 1]!
      const cell = cellKeyOf(lat, lon)
      const key = cell * DAY_KEY_SPAN + day
      const at = index.get(key)
      if (at === undefined) {
        index.set(key, counts.length)
        sumLat.push(lat)
        sumLon.push(lon)
        counts.push(1)
        cells.push(cell)
        days.push(day)
      } else {
        sumLat[at]! += lat
        sumLon[at]! += lon
        counts[at]! += 1
      }
      const b = dayBounds.get(day)
      if (!b) dayBounds.set(day, [t, tz, t, tz])
      else {
        if (t < b[0]) {
          b[0] = t
          b[1] = tz
        }
        if (t > b[2]) {
          b[2] = t
          b[3] = tz
        }
      }
    }
  }

  // 日番号の昇順に並べ替える（trips が時刻順でなくても結果が変わらないように）
  const count = counts.length
  const order = Array.from({ length: count }, (_, i) => i)
  order.sort((a, b) => days[a]! - days[b]!)
  const lat = new Float64Array(count)
  const lon = new Float64Array(count)
  const cell = new Float64Array(count)
  const day = new Int32Array(count)
  for (let j = 0; j < count; j++) {
    const i = order[j]!
    lat[j] = sumLat[i]! / counts[i]!
    lon[j] = sumLon[i]! / counts[i]!
    cell[j] = cells[i]!
    day[j] = days[i]!
  }
  const dayStartTz = new Map<number, number>()
  const dayEndTz = new Map<number, number>()
  for (const [d, b] of dayBounds) {
    dayStartTz.set(d, b[1])
    dayEndTz.set(d, b[3])
  }

  const result: Presences = { count, lat, lon, cell, day, dayStartTz, dayEndTz, flightDays }
  presenceCache.set(source.trips, { tzChanges: source.tzChanges, result })
  return result
}

/** 生活圏の拠点（格子）。座標はその格子に入った在圏の平均 */
export interface Anchor {
  lat: number
  lon: number
  /** その格子に在圏があった日数 */
  days: number
}

export interface YearAnchors {
  year: number
  /** その年で最も多くの日に居た格子＝自宅とみなす */
  home: Anchor
  /**
   * home を含む拠点の一覧。遠征の判定はこのどれからも離れた日を「遠出」とする。
   * 片道 60km の通勤先や、年の途中で引っ越した先を遠征と数えないため。
   */
  anchors: Anchor[]
  /** 在圏のあった日数 */
  days: number
  /** この年の在圏の範囲 [from, to)（Presences の添字） */
  from: number
  to: number
}

/** 年の在圏日数に対してこの割合以上の日に居た格子は、自宅以外でも拠点とみなす */
const SECONDARY_ANCHOR_SHARE = 0.2
/** ただし記録の少ない年に、数日居ただけの場所を拠点にしないための下限 */
const SECONDARY_ANCHOR_MIN_DAYS = 14

const anchorCache = new WeakMap<Presences, Map<number, YearAnchors>>()

/**
 * 年ごとの拠点を求める。
 *
 * 自宅は「最も多くの日に居た格子」（最頻の格子）にする。平均座標から始めると、
 * 1 回の欧州旅行で重心が海の上へ引きずられ、そこを基準にした判定がすべて狂う。
 * 最頻値は外れ値の影響を受けない。格子の境目に家があると日数が 2 つに割れるが、
 * 基準点がずれるのは高々 1km で、300km・50km といった判定には効かない。
 */
export function yearAnchors(p: Presences): Map<number, YearAnchors> {
  const cached = anchorCache.get(p)
  if (cached) return cached

  const out = new Map<number, YearAnchors>()
  let from = 0
  while (from < p.count) {
    const year = dayNumberToYear(p.day[from]!)
    let to = from
    let days = 0
    let lastDay = Number.NaN
    // 格子キー → [日数, 緯度の和, 経度の和]。在圏は（格子, 日）で一意なので件数＝日数
    const byCell = new Map<number, [number, number, number]>()
    while (to < p.count && dayNumberToYear(p.day[to]!) === year) {
      const d = p.day[to]!
      if (d !== lastDay) {
        days++
        lastDay = d
      }
      const c = p.cell[to]!
      const acc = byCell.get(c)
      if (acc) {
        acc[0]++
        acc[1] += p.lat[to]!
        acc[2] += p.lon[to]!
      } else byCell.set(c, [1, p.lat[to]!, p.lon[to]!])
      to++
    }

    let best: [number, number, number] | null = null
    for (const acc of byCell.values()) {
      // 同数なら先に現れた（＝その年で早く居た）格子を残す。結果を決定的にするため
      if (!best || acc[0] > best[0]) best = acc
    }
    const toAnchor = (a: [number, number, number]): Anchor => ({
      lat: a[1] / a[0],
      lon: a[2] / a[0],
      days: a[0],
    })
    const home = toAnchor(best!)
    const minDays = Math.max(SECONDARY_ANCHOR_MIN_DAYS, days * SECONDARY_ANCHOR_SHARE)
    const anchors = [home]
    for (const acc of byCell.values()) {
      if (acc !== best && acc[0] >= minDays) anchors.push(toAnchor(acc))
    }
    out.set(year, { year, home, anchors, days, from, to })
    from = to
  }

  anchorCache.set(p, out)
  return out
}

export interface YearBarycenter {
  year: number
  /** 重心（生活圏の中心。遠出は除外） */
  lat: number
  lon: number
  /** 回転半径（重心からの RMS 距離）＝行動半径 */
  radiusKm: number
  /** 在圏のあった日数 */
  days: number
  /** 在圏の件数（遠出も含む） */
  presences: number
  /** 基準にした自宅の格子 */
  homeCell: { lat: number; lon: number }
  /** 自宅から outlierKm より遠い在圏の割合（0..1） */
  awayShare: number
  /** 前の年（表に並ぶ直前の年）の重心からの移動距離。最初の年は null */
  shiftKm: number | null
}

export interface BarycenterOptions {
  /** 自宅からこれより遠い在圏は重心・回転半径に入れない（既定 300km） */
  outlierKm?: number
}

export const DEFAULT_OUTLIER_KM = 300
const KM_PER_DEG_LAT = 110.574
const KM_PER_DEG_LON_EQUATOR = 111.32

function wrapLon(dLon: number): number {
  if (dLon > 180) return dLon - 360
  if (dLon < -180) return dLon + 360
  return dLon
}

/**
 * 年ごとの重心と回転半径。
 *
 * 単純な平均にしない理由: 在圏の 5% が欧州にあるだけで、東京の生活圏の平均座標は
 * 数百 km 西の海上へずれ、回転半径も数千 km になる。これでは「生活圏の変化」が読めない。
 * そこで年ごとに最頻の格子（自宅）を基準にし、そこから outlierKm 以内の在圏だけで
 * 重心と回転半径を計算する。外に出た分は捨てずに awayShare として別に示す
 * （「遠出の多い年だった」こと自体は情報なので）。
 *
 * 平均と RMS は自宅を原点にした平面（正距円筒）で取る。300km 以内なら歪みは 1% 未満で、
 * 経度差を ±180° に畳むので日付変更線の近くでも破綻しない。
 * 重みは在圏 1 件＝1。滞在時間は使わない（年で記録の濃さが違うため。冒頭参照）。
 */
export function yearlyBarycenters(
  source: PresenceSource,
  opts?: BarycenterOptions,
): YearBarycenter[] {
  const outlierKm = opts?.outlierKm ?? DEFAULT_OUTLIER_KM
  const p = collectPresences(source)
  const out: YearBarycenter[] = []

  for (const ya of yearAnchors(p).values()) {
    const { home, from, to } = ya
    const kmPerDegLon = KM_PER_DEG_LON_EQUATOR * Math.cos((home.lat * Math.PI) / 180)
    let n = 0
    let sx = 0
    let sy = 0
    let sxx = 0
    let syy = 0
    let away = 0
    for (let i = from; i < to; i++) {
      const km = haversineMeters(home.lat, home.lon, p.lat[i]!, p.lon[i]!) / 1000
      if (km > outlierKm) {
        away++
        continue
      }
      const x = wrapLon(p.lon[i]! - home.lon) * kmPerDegLon
      const y = (p.lat[i]! - home.lat) * KM_PER_DEG_LAT
      n++
      sx += x
      sy += y
      sxx += x * x
      syy += y * y
    }
    // 自宅の格子そのものは必ず outlierKm 以内なので n >= 1
    const mx = sx / n
    const my = sy / n
    const variance = Math.max(0, sxx / n - mx * mx + (syy / n - my * my))
    const lat = home.lat + my / KM_PER_DEG_LAT
    const lon = wrapLon(home.lon + (kmPerDegLon > 1e-9 ? mx / kmPerDegLon : 0))
    const prev = out[out.length - 1]
    out.push({
      year: ya.year,
      lat,
      lon,
      radiusKm: Math.sqrt(variance),
      days: ya.days,
      presences: to - from,
      homeCell: { lat: home.lat, lon: home.lon },
      awayShare: away / (to - from),
      shiftKm: prev ? haversineMeters(prev.lat, prev.lon, lat, lon) / 1000 : null,
    })
  }
  return out
}

/** a から b への方位角（度、北 = 0、時計回り） */
export function bearingDeg(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const phi1 = (a.lat * Math.PI) / 180
  const phi2 = (b.lat * Math.PI) / 180
  const dLambda = (wrapLon(b.lon - a.lon) * Math.PI) / 180
  const y = Math.sin(dLambda) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda)
  const deg = (Math.atan2(y, x) * 180) / Math.PI
  return (deg + 360) % 360
}

const COMPASS_JA = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'] as const

/** 方位角 → 8 方位の日本語。地名が無いデータなので、場所の代わりに方角で示す */
export function compassJa(deg: number): string {
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8
  return COMPASS_JA[i]!
}
