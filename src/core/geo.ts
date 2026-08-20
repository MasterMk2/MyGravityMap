/**
 * 座標・時刻まわりの純粋関数。DESIGN.md §6.1 の前提（同時刻別座標・粗い間隔・
 * 長距離便の大圏補間）を扱う trips.ts の土台。副作用なし。
 */

const LAT_LNG_RE = /(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)\s*°?/

/** "35.1234567°, 139.7654321°" -> [lat, lon]。° は多バイト文字なので split せず、
 *  数値だけを正規表現で拾う。° 無し・余分な空白入りも許容する。解釈不能なら例外。 */
export function parseLatLng(s: string): [number, number] {
  const m = LAT_LNG_RE.exec(s)
  if (!m) {
    throw new Error(`parseLatLng: unparseable input: ${JSON.stringify(s)}`)
  }
  const lat = Number(m[1])
  const lon = Number(m[2])
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    throw new Error(`parseLatLng: unparseable input: ${JSON.stringify(s)}`)
  }
  return [lat, lon]
}

/** ISO 8601（オフセット付き）を Unix 秒（整数、切り捨て）に変換する。 */
export function parseTimeSec(s: string): number {
  const ms = Date.parse(s)
  if (Number.isNaN(ms)) {
    throw new Error(`parseTimeSec: unparseable input: ${JSON.stringify(s)}`)
  }
  return Math.floor(ms / 1000)
}

/** 文字列末尾の UTC オフセットを分単位で取り出す。"+09:00" -> 540、"Z" -> 0。
 *  無ければ null。 */
export function tzOffsetMinFromIso(s: string): number | null {
  const m = /(Z)$|([+-])(\d{2}):?(\d{2})$/.exec(s)
  if (!m) return null
  if (m[1] === 'Z') return 0
  const sign = m[2] === '-' ? -1 : 1
  const hh = Number(m[3])
  const mm = Number(m[4])
  return sign * (hh * 60 + mm)
}

const EARTH_RADIUS_M = 6371000

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI
}

/** 大圏距離（メートル）。 */
export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const phi1 = toRad(aLat)
  const phi2 = toRad(bLat)
  const dPhi = toRad(bLat - aLat)
  const dLambda = toRad(bLon - aLon)
  const sinDPhi = Math.sin(dPhi / 2)
  const sinDLambda = Math.sin(dLambda / 2)
  const h = sinDPhi * sinDPhi + Math.cos(phi1) * Math.cos(phi2) * sinDLambda * sinDLambda
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
  return EARTH_RADIUS_M * c
}

/** a と b の間（両端を含まない）に大圏コース上の中間点を n 個生成する（slerp）。
 *  n=0 なら []。戻り値は [lat, lon] の並び（引数と同じ順序）。 */
export function greatCircleIntermediate(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
  n: number,
): Array<[number, number]> {
  if (n <= 0) return []

  const phi1 = toRad(aLat)
  const lambda1 = toRad(aLon)
  const phi2 = toRad(bLat)
  const lambda2 = toRad(bLon)

  // 単位ベクトルへ変換
  const ax = Math.cos(phi1) * Math.cos(lambda1)
  const ay = Math.cos(phi1) * Math.sin(lambda1)
  const az = Math.sin(phi1)
  const bx = Math.cos(phi2) * Math.cos(lambda2)
  const by = Math.cos(phi2) * Math.sin(lambda2)
  const bz = Math.sin(phi2)

  const dot = Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz))
  const d = Math.acos(dot)

  const out: Array<[number, number]> = []

  if (d < 1e-12) {
    // 実質同一点。中間点も同じ座標を返す。
    for (let i = 0; i < n; i++) out.push([aLat, aLon])
    return out
  }

  const sinD = Math.sin(d)
  for (let i = 1; i <= n; i++) {
    const f = i / (n + 1)
    const A = Math.sin((1 - f) * d) / sinD
    const B = Math.sin(f * d) / sinD
    const x = A * ax + B * bx
    const y = A * ay + B * by
    const z = A * az + B * bz
    const lat = toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)))
    const lon = toDeg(Math.atan2(y, x))
    out.push([lat, lon])
  }
  return out
}

function shiftedUtcDate(tSec: number, tzOffsetMin: number): Date {
  // 機械のタイムゾーンに依存しないよう、UTC 秒に tzOffsetMin を足してから
  // UTC ゲッターで読む。
  return new Date((tSec + tzOffsetMin * 60) * 1000)
}

/** 記録側タイムゾーンでの暦日を 'YYYY-MM-DD' で返す。 */
export function localDayKey(tSec: number, tzOffsetMin: number): string {
  const d = shiftedUtcDate(tSec, tzOffsetMin)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 記録側タイムゾーンでの時（0-23）。 */
export function localHour(tSec: number, tzOffsetMin: number): number {
  return shiftedUtcDate(tSec, tzOffsetMin).getUTCHours()
}

/** 記録側タイムゾーンでの曜日（0=日曜〜6=土曜）。 */
export function localWeekday(tSec: number, tzOffsetMin: number): number {
  return shiftedUtcDate(tSec, tzOffsetMin).getUTCDay()
}
