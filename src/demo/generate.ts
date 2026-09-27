/**
 * デモ用の合成タイムライン（DESIGN.md §8 未決事項 C）。
 *
 * 公開版を開いた人が、自分のエクスポートを持っていなくても試せるようにするためのもの。
 * 「架空の人物」の約 7 年半分（2019-04 〜 2026-08）の履歴を、Google の書き出しと同じ生の形式
 * （semanticSegments / userLocationProfile）で作る。生の形式で出すのは、実ファイルとまったく同じ
 * 収集器（core/segments.ts）と後段（core/pipeline.ts）を通すため。デモ専用の近道を作ると
 * 「デモでは動くのに実データでは壊れる」が起きる。
 *
 * ★ この人物は架空。自宅・勤め先・立ち寄り先は、札幌や東京などの市街中心（誰でも知っている
 *   公開の地名）から乱数でずらした点にすぎず、実在の住所や誰かの記録とは関係ない。
 *   実データを縮めて使わないのは、座標そのものが個人情報だから（DESIGN.md §8 C / §9）。
 *
 * 決定的に作る: 同じ seed なら同じ出力。Math.random や Date.now は使わない。
 * 解析結果は「seed と生成器の版」をキーにキャッシュするので、出力が揺れると
 * 同じキーで中身が違うことになる。
 *
 * rawSignals は出さない。実データでは Wi-Fi の MAC アドレスなどが入っている部分で、
 * Worker は件数を数えて捨てるだけ（§9）。合成しても画面には何も出ないうえ、
 * 「MAC アドレスらしきもの」を公開物に置く理由が無い。
 *
 * 作り方は 3 段:
 * 1. 暮らしの予定（どこに何時から何時まで居て、どう移動したか）を日ごとに組み立てる
 * 2. それを「スマホが記録した点」に変える（移動中は密に、じっとしている間は疎らに）
 * 3. 年による記録の非対称（§1.2 / §1.2.1）を掛けて、Google の形式に書き出す
 */
import type { RawProfile, RawSegment } from '../core/segments'
import type { TravelMode } from '../core/types'
import { haversineMeters } from '../core/geo'

/** 既定の seed。値そのものに意味は無い（期間の開始日を並べただけ） */
export const DEMO_SEED = 20190401

/**
 * 生成器の版。出力が 1 バイトでも変わる変更をしたら上げる。
 * IndexedDB のキャッシュキー（store の loadDemo）に入っているので、上げ忘れると
 * 前の版で解析したデモが使われ続ける。tests/demo.test.ts の固定ハッシュがこの上げ忘れを検知する。
 */
export const DEMO_VERSION = 1

/**
 * Dataset.fileName に入る名前。画面の「読み込んだファイル」欄にそのまま出る。
 * 見出しには「デモ」の札が前に付くので、名前の側では「デモ」と繰り返さない。
 */
export const DEMO_FILE_NAME = '架空の人物（札幌）'

/**
 * この日（日本時間 0 時）から Google の visit / activity が出て、軌跡も濃くなる。
 * 実データで Google が端末内処理に切り替わった時期に合わせてある（DESIGN.md §1.2）。
 */
export const DEMO_DENSE_FROM = '2024-10-01'

export interface DemoOptions {
  /** 'YYYY-MM-DD'（日本時間の暦日）。既定 2019-04-01。テストで期間を縮めるためのもの */
  start?: string
  /** 'YYYY-MM-DD'（この日を含む）。既定 2026-08-31 */
  end?: string
}

export interface DemoHistory {
  semanticSegments: RawSegment[]
  userLocationProfile: RawProfile
}

const DEFAULT_START = '2019-04-01'
const DEFAULT_END = '2026-08-31'

/** 転居。年ごとの重心がはっきり動くのを見せるため、期間の真ん中あたりに置く */
const MOVE_DATE = '2022-07-16'
/** 転職。通勤先が郊外に変わり、通勤手段も地下鉄から車になる */
const JOB_CHANGE_DATE = '2024-04-01'
/** 端末の故障で記録が丸ごと無い 3 週間。「空白スキップ」で飛ばされる区間の見本 */
const OUTAGE_FROM = '2021-06-07'
const OUTAGE_TO = '2021-06-27'

/*
 * 古い年の記録の薄さ。検証ハーネス（DESIGN.md §8 D）が 2025 年を 2019 年の密度まで
 * 間引いたときと同じ 2 段構えにしてある: 2 時間バケットを 41% 残し、残ったバケットの点を間引く。
 * 点の残し方はハーネスの 69% より多めにした。合成の暮らしは実データより移動が少なく、
 * 69% だと 1 日 17 点ほどまで落ちて、実データの 2019 年（22.5 点/日）より薄くなるため。
 * それに加えて、実データの 2019 年は 365 日中 275 日しか記録が無いので、日ごと丸ごと落とす。
 */
const OLD_BUCKET_KEEP = 0.41
const OLD_POINT_KEEP = 0.85
const OLD_DAY_OFF = 0.22

const JST = 540
const DAY_SEC = 86_400
const BUCKET_SEC = 7_200
const M_PER_DEG = 111_320

type DestKey = 'tokyo' | 'okinawa' | 'kansai' | 'taipei' | 'helsinki'

/**
 * 泊まりがけの旅行（出発日・行き先・泊数）。
 * 2020〜2021 年は旅行を控えた年として少なくしてある（年ごとの「遠征」の差が見える）。
 * 海外は台北（UTC+8）とヘルシンキ（夏は UTC+3）。ハワイは日付変更線をまたぐ線の描画を
 * 試す準備がまだ無いので避けた。
 */
const TRIPS: ReadonlyArray<readonly [string, DestKey, number]> = [
  ['2019-05-03', 'tokyo', 3],
  ['2019-07-19', 'okinawa', 3],
  ['2019-09-13', 'kansai', 3],
  ['2019-11-22', 'taipei', 3],
  ['2020-02-14', 'tokyo', 2],
  ['2020-10-23', 'kansai', 2],
  ['2021-11-12', 'tokyo', 2],
  ['2022-03-18', 'tokyo', 2],
  ['2022-05-02', 'okinawa', 4],
  ['2022-10-07', 'kansai', 3],
  ['2022-12-09', 'tokyo', 2],
  ['2023-02-10', 'tokyo', 2],
  ['2023-06-16', 'okinawa', 3],
  ['2023-09-15', 'kansai', 3],
  ['2023-11-23', 'taipei', 4],
  ['2024-02-09', 'tokyo', 2],
  ['2024-05-03', 'okinawa', 3],
  ['2024-08-09', 'kansai', 4],
  ['2024-11-15', 'tokyo', 2],
  ['2025-01-24', 'tokyo', 2],
  ['2025-03-20', 'okinawa', 3],
  ['2025-07-11', 'helsinki', 7],
  ['2025-10-10', 'kansai', 3],
  ['2025-12-05', 'tokyo', 2],
  ['2026-02-20', 'tokyo', 2],
  ['2026-05-01', 'okinawa', 4],
  ['2026-07-17', 'kansai', 3],
]

// ---------------------------------------------------------------
// 乱数・座標・時刻の道具
// ---------------------------------------------------------------

/** mulberry32。周期 2^32 で、デモの規模（数十万回）には十分。環境によらず同じ列が出る */
class Rng {
  private s: number
  constructor(seed: number) {
    this.s = seed >>> 0
  }
  float(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.float()
  }
  /** a 以上 b 以下の整数 */
  int(a: number, b: number): number {
    return a + Math.floor((b - a + 1) * this.float())
  }
  chance(p: number): boolean {
    return this.float() < p
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.float() * xs.length)]
  }
  /** 標準正規乱数（Box-Muller）。1 - u にして log(0) を避ける */
  normal(): number {
    const u = 1 - this.float()
    const v = this.float()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}

interface LatLon {
  lat: number
  lon: number
}

/** p から方位 bearingDeg（北が 0・時計回り）へ meters ずらした点。数十 km までなら平面近似で足りる */
function offset(p: LatLon, meters: number, bearingDeg: number): LatLon {
  const b = (bearingDeg * Math.PI) / 180
  return {
    lat: p.lat + (meters * Math.cos(b)) / M_PER_DEG,
    lon: p.lon + (meters * Math.sin(b)) / (M_PER_DEG * Math.cos((p.lat * Math.PI) / 180)),
  }
}

/** GPS の揺れ。各軸に標準偏差 sigmaM メートルの正規乱数を足す */
function jitter(p: LatLon, sigmaM: number, rng: Rng): LatLon {
  return {
    lat: p.lat + (rng.normal() * sigmaM) / M_PER_DEG,
    lon: p.lon + (rng.normal() * sigmaM) / (M_PER_DEG * Math.cos((p.lat * Math.PI) / 180)),
  }
}

function dist(a: LatLon, b: LatLon): number {
  return haversineMeters(a.lat, a.lon, b.lat, b.lon)
}

/** 'YYYY-MM-DD' → 1970-01-01 からの日数（暦日の番号。どの TZ の暦かは使う側が決める） */
function dayNumber(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) throw new Error(`日付は YYYY-MM-DD で指定してください: ${ymd}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / (DAY_SEC * 1000)
}

/** 暦日 day の、UTC オフセット tz（分）での minutes 分（0 時から）を Unix 秒にする */
function at(day: number, tz: number, minutes: number): number {
  return day * DAY_SEC + Math.round(minutes * 60) - tz * 60
}

/** Unix 秒 t が、オフセット tz の暦で何日目か */
function dayOf(t: number, tz: number): number {
  return Math.floor((t + tz * 60) / DAY_SEC)
}

function localHour(t: number, tz: number): number {
  return Math.floor((((t + tz * 60) % DAY_SEC) + DAY_SEC) % DAY_SEC / 3600)
}

/** 0 = 日曜。1970-01-01 は木曜 */
function weekday(day: number): number {
  return (((day + 4) % 7) + 7) % 7
}

function monthDay(day: number): [number, number] {
  const d = new Date(day * DAY_SEC * 1000)
  return [d.getUTCMonth() + 1, d.getUTCDate()]
}

/** 年末年始・ゴールデンウィーク・お盆は休み。祝日を全部持つほどの意味は無いので主な連休だけ */
function isHoliday(day: number): boolean {
  const [m, d] = monthDay(day)
  return (
    (m === 12 && d >= 29) || (m === 1 && d <= 3) || (m === 5 && d >= 3 && d <= 5) || (m === 8 && d >= 13 && d <= 15)
  )
}

/** 札幌で自転車に乗れる季節（雪のある時期は乗らない） */
function isSummer(day: number): boolean {
  const [m] = monthDay(day)
  return m >= 5 && m <= 10
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Google と同じ「オフセット付き ISO 8601」。例: 2025-03-14T18:42:00.000+09:00 */
function iso(t: number, tz: number): string {
  const d = new Date((t + tz * 60) * 1000)
  const a = Math.abs(tz)
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}.000` +
    `${tz < 0 ? '-' : '+'}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`
  )
}

/** Google と同じ座標文字列。例: "43.0621000°, 141.3544000°" */
function latLng(p: LatLon): string {
  return `${p.lat.toFixed(7)}°, ${p.lon.toFixed(7)}°`
}

function r3(x: number): number {
  return Math.round(x * 1000) / 1000
}

// ---------------------------------------------------------------
// 場所（すべて架空）
// ---------------------------------------------------------------

interface DemoPlace extends LatLon {
  /** demo-place-<n>。場所ごとに固定なので、Google の placeId と同じく集約キーになる */
  id: string
  /** その場所の UTC オフセット（分） */
  tz: number
  /** away は旅先の宿や観光地。地図で住所を調べて行く先なので SEARCHED_ADDRESS が付くことがある */
  kind: 'home' | 'work' | 'other' | 'away'
  /** hierarchyLevel 1 の visit として重ねて出す親施設（モールや空港の全体） */
  parent?: DemoPlace
}

interface Destination {
  tz: number
  airport: DemoPlace
  hotel: DemoPlace
  spots: DemoPlace[]
  /** 空港と宿のあいだの移動手段 */
  access: TravelMode
  /** 現地で 1.5km を超える移動に使う手段（それ未満は歩く） */
  far: TravelMode
  /** 新千歳（ヘルシンキは羽田）からの飛行時間（分） */
  flightMin: number
  /** 羽田で乗り継ぐ */
  viaHaneda: boolean
  /** 2 日目に足を延ばす先（関西なら京都） */
  side?: { spots: DemoPlace[]; mode: TravelMode }
}

interface World {
  home1: DemoPlace
  home2: DemoPlace
  work1: DemoPlace
  work2: DemoPlace
  lunch1: DemoPlace[]
  lunch2: DemoPlace[]
  gym1: DemoPlace
  gym2: DemoPlace
  super1: DemoPlace
  super2: DemoPlace
  restaurants: DemoPlace[]
  cafes: DemoPlace[]
  parks: DemoPlace[]
  friends: DemoPlace[]
  /** モールごとの店（level 0）。店の parent がモール全体（level 1） */
  malls: DemoPlace[][]
  otaru: DemoPlace[]
  asahikawa: DemoPlace[]
  cts: DemoPlace
  hnd: DemoPlace
  dest: Record<DestKey, Destination>
  moveDay: number
  jobDay: number
}

/** 札幌の市街中心（札幌駅と大通の間あたり）。ここからずらして架空の場所を置く */
const SAPPORO: LatLon = { lat: 43.0621, lon: 141.3544 }

function buildWorld(rng: Rng): World {
  let n = 0
  const mk = (p: LatLon, tz: number, kind: DemoPlace['kind'] = 'other', parent?: DemoPlace): DemoPlace => ({
    id: `demo-place-${++n}`,
    lat: p.lat,
    lon: p.lon,
    tz,
    kind,
    ...(parent ? { parent } : {}),
  })
  const around = (c: LatLon, minM: number, maxM: number, b0 = 0, b1 = 360): LatLon =>
    offset(c, rng.range(minM, maxM), rng.range(b0, b1))
  const many = (
    count: number,
    c: LatLon,
    minM: number,
    maxM: number,
    tz: number,
    b0 = 0,
    b1 = 360,
    kind: DemoPlace['kind'] = 'other',
  ) => Array.from({ length: count }, () => mk(around(c, minM, maxM, b0, b1), tz, kind))
  /** 旅先の場所 */
  const away = (count: number, c: LatLon, minM: number, maxM: number, tz: number, b0 = 0, b1 = 360) =>
    many(count, c, minM, maxM, tz, b0, b1, 'away')
  /** 札幌市内。3km より外は南西の山側を避ける（公園やモールが山の中に立たないように） */
  const sapporo = (minM: number, maxM: number): LatLon => {
    const d = rng.range(minM, maxM)
    return offset(SAPPORO, d, d > 3_000 ? rng.range(-70, 190) : rng.range(0, 360))
  }
  const sapporoMany = (count: number, minM: number, maxM: number) =>
    Array.from({ length: count }, () => mk(sapporo(minM, maxM), JST))
  /** 空港は「ターミナル全体（level 1）」と「搭乗口あたり（level 0）」の 2 つを作る */
  const airport = (p: LatLon, tz: number): DemoPlace => mk(around(p, 60, 150), tz, 'other', mk(p, tz))

  // 旧居と新居は市の中心を挟んだ反対側に置く。転居で重心が数 km 動く
  const b1 = rng.range(0, 360)
  const b2 = b1 + rng.range(140, 220)
  const home1 = mk(offset(SAPPORO, rng.range(2_500, 3_800), b1), JST, 'home')
  const home2 = mk(offset(SAPPORO, rng.range(2_500, 3_800), b2), JST, 'home')
  // 前の職場は都心、次の職場は郊外（北〜東の平地）で、新居とは別の方角
  const work1 = mk(around(SAPPORO, 300, 1_200), JST, 'work')
  let bw = rng.range(20, 160)
  for (let i = 0; i < 10 && Math.abs(((bw - b2 + 540) % 360) - 180) < 60; i++) bw = rng.range(20, 160)
  const work2 = mk(offset(SAPPORO, rng.range(5_000, 7_000), bw), JST, 'work')

  const lunch1 = many(4, work1, 150, 500, JST)
  const lunch2 = many(4, work2, 150, 500, JST)
  const gym1 = mk(around(home1, 300, 900), JST)
  const gym2 = mk(around(home2, 300, 900), JST)
  const super1 = mk(around(home1, 200, 700), JST)
  const super2 = mk(around(home2, 200, 700), JST)
  const restaurants = sapporoMany(12, 300, 3_500)
  const cafes = sapporoMany(6, 200, 3_000)
  const parks = sapporoMany(5, 1_000, 6_500)
  const friends = sapporoMany(3, 2_000, 7_500)
  const malls = Array.from({ length: 3 }, () => {
    const facility = mk(sapporo(2_000, 7_000), JST)
    return Array.from({ length: 3 }, () => mk(around(facility, 30, 100), JST, 'other', facility))
  })

  // 日帰りの行き先。小樽は北が海なので南西側に、旭川は盆地なので全方位
  const otaru = many(4, { lat: 43.1907, lon: 140.9947 }, 200, 1_000, JST, 120, 270)
  const asahikawa = many(3, { lat: 43.7706, lon: 142.365 }, 500, 4_000, JST)

  const cts = airport({ lat: 42.7752, lon: 141.6923 }, JST)
  const hnd = airport({ lat: 35.5494, lon: 139.7798 }, JST)

  const tokyoC = { lat: 35.6812, lon: 139.7671 }
  const nahaC = { lat: 26.2124, lon: 127.6792 }
  const osakaC = { lat: 34.7025, lon: 135.4959 }
  const kyotoC = { lat: 35.0116, lon: 135.7681 }
  const taipeiC = { lat: 25.033, lon: 121.5654 }
  const helsinkiC = { lat: 60.1699, lon: 24.9384 }

  const dest: Record<DestKey, Destination> = {
    // 東京湾（南東）に落ちないよう南西〜北東だけに置く
    tokyo: {
      tz: JST,
      airport: hnd,
      hotel: mk(around(tokyoC, 300, 2_000, 210, 450), JST, 'away'),
      spots: away(6, tokyoC, 1_000, 8_000, JST, 210, 450),
      access: 'IN_TRAIN',
      far: 'IN_SUBWAY',
      flightMin: 95,
      viaHaneda: false,
    },
    // 沖縄本島は那覇から北北東へ細長いので、その向きに沿って置く。現地はレンタカー
    okinawa: {
      tz: JST,
      airport: airport({ lat: 26.1958, lon: 127.6459 }, JST),
      hotel: mk(around(nahaC, 300, 1_500, 0, 150), JST, 'away'),
      spots: away(5, nahaC, 3_000, 45_000, JST, 15, 40),
      access: 'IN_PASSENGER_VEHICLE',
      far: 'IN_PASSENGER_VEHICLE',
      flightMin: 175,
      viaHaneda: false,
    },
    // 伊丹から大阪市内はバス。2 日目は電車で京都へ
    kansai: {
      tz: JST,
      airport: airport({ lat: 34.7855, lon: 135.4382 }, JST),
      hotel: mk(around(osakaC, 300, 1_500, 60, 220), JST, 'away'),
      spots: away(4, osakaC, 1_000, 5_000, JST, 60, 220),
      access: 'IN_BUS',
      far: 'IN_SUBWAY',
      flightMin: 115,
      viaHaneda: false,
      side: { spots: away(4, kyotoC, 500, 3_500, JST), mode: 'IN_TRAIN' },
    },
    taipei: {
      tz: 480,
      airport: airport({ lat: 25.0797, lon: 121.2342 }, 480),
      hotel: mk(around(taipeiC, 300, 1_500), 480, 'away'),
      spots: away(5, taipeiC, 1_000, 6_000, 480),
      access: 'IN_TRAIN',
      far: 'IN_SUBWAY',
      flightMin: 245,
      viaHaneda: false,
    },
    // 夏（7 月）に行くので UTC+3。南は海なので北側に置く。市内は路面電車
    helsinki: {
      tz: 180,
      airport: airport({ lat: 60.3172, lon: 24.9633 }, 180),
      hotel: mk(around(helsinkiC, 200, 1_000, 290, 430), 180, 'away'),
      spots: away(5, helsinkiC, 500, 4_000, 180, 290, 430),
      access: 'IN_TRAIN',
      far: 'IN_TRAM',
      flightMin: 800,
      viaHaneda: true,
    },
  }

  return {
    home1,
    home2,
    work1,
    work2,
    lunch1,
    lunch2,
    gym1,
    gym2,
    super1,
    super2,
    restaurants,
    cafes,
    parks,
    friends,
    malls,
    otaru,
    asahikawa,
    cts,
    hnd,
    dest,
    moveDay: dayNumber(MOVE_DATE),
    jobDay: dayNumber(JOB_CHANGE_DATE),
  }
}

const homeAt = (w: World, day: number) => (day < w.moveDay ? w.home1 : w.home2)
const workAt = (w: World, day: number) => (day < w.jobDay ? w.work1 : w.work2)
const gymAt = (w: World, day: number) => (day < w.moveDay ? w.gym1 : w.gym2)
const superAt = (w: World, day: number) => (day < w.moveDay ? w.super1 : w.super2)
const lunchAt = (w: World, day: number) => (day < w.jobDay ? w.lunch1 : w.lunch2)

// ---------------------------------------------------------------
// 1. 暮らしの予定
// ---------------------------------------------------------------

interface Stay {
  kind: 'stay'
  place: DemoPlace
  start: number
  end: number
}

interface Leg {
  kind: 'leg'
  from: DemoPlace
  to: DemoPlace
  mode: TravelMode
  start: number
  end: number
  /** 道なりに見せるため少し曲げた折れ線。両端は from / to */
  path: LatLon[]
  meters: number
}

type Item = Stay | Leg

/** 道の曲がり。直線だと再生したときに定規で引いたように見えるので、途中の点を横へずらす */
function roadPath(a: LatLon, b: LatLon, rng: Rng): LatLon[] {
  const d = dist(a, b)
  const bends = d < 1_500 ? 1 : d < 15_000 ? 2 : 4
  const bearing =
    (Math.atan2((b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat) * 180) / Math.PI
  const out: LatLon[] = [{ lat: a.lat, lon: a.lon }]
  for (let i = 1; i <= bends; i++) {
    const f = i / (bends + 1)
    const base = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }
    out.push(offset(base, rng.normal() * 0.06 * d, bearing + 90))
  }
  out.push({ lat: b.lat, lon: b.lon })
  return out
}

function pathMeters(path: LatLon[]): number {
  let m = 0
  for (let i = 1; i < path.length; i++) m += dist(path[i - 1], path[i])
  return m
}

/**
 * 移動にかかる秒数。徒歩 約 5km/h、市内の車 約 30km/h、電車 約 45〜95km/h。
 * 乗り物には駅まで歩く・待つ・駐車する分を足す。
 */
function travelSeconds(mode: TravelMode, meters: number): number {
  const long = meters > 20_000
  const kmh =
    mode === 'WALKING'
      ? 4.8
      : mode === 'CYCLING'
        ? 14
        : mode === 'IN_PASSENGER_VEHICLE'
          ? long ? 75 : 30
          : mode === 'IN_TRAIN'
            ? long ? 95 : 45
            : mode === 'IN_BUS'
              ? long ? 50 : 20
              : mode === 'IN_TRAM'
                ? 16
                : 32 // 地下鉄
  const overhead = mode === 'WALKING' || mode === 'CYCLING' ? 0 : mode === 'IN_PASSENGER_VEHICLE' ? 180 : 360
  return Math.max(120, Math.round(meters / (kmh / 3.6)) + overhead)
}

/**
 * 予定を時刻順に積む。「今いる場所」と「そこに着いた時刻」を持ち、
 * go() で滞在を閉じて移動を足す。予定が押していれば出発も遅れる（時刻が逆行しない）。
 */
class Itinerary {
  readonly items: Item[] = []
  place: DemoPlace
  since: number
  private readonly rng: Rng

  constructor(place: DemoPlace, since: number, rng: Rng) {
    this.place = place
    this.since = since
    this.rng = rng
  }

  go(to: DemoPlace, mode: TravelMode, departAt: number): void {
    if (to === this.place) return
    const start = Math.max(departAt, this.since + 60)
    const path = roadPath(this.place, to, this.rng)
    const meters = pathMeters(path)
    const end = start + travelSeconds(mode, meters)
    this.items.push({ kind: 'stay', place: this.place, start: this.since, end: start })
    this.items.push({ kind: 'leg', from: this.place, to, mode, start, end, path, meters })
    this.place = to
    this.since = end
  }

  fly(to: DemoPlace, departAt: number, minutes: number): void {
    const start = Math.max(departAt, this.since + 60)
    const end = start + Math.round(minutes * 60)
    this.items.push({ kind: 'stay', place: this.place, start: this.since, end: start })
    this.items.push({
      kind: 'leg',
      from: this.place,
      to,
      mode: 'FLYING',
      start,
      end,
      path: [this.place, to],
      meters: dist(this.place, to),
    })
    this.place = to
    this.since = end
  }

  close(end: number): void {
    this.items.push({ kind: 'stay', place: this.place, start: this.since, end: Math.max(end, this.since + 60) })
  }
}

/** 市内の移動手段を距離と季節で選ぶ */
function cityMode(a: LatLon, b: LatLon, day: number, rng: Rng): TravelMode {
  const d = dist(a, b)
  if (d < 1_200) return isSummer(day) && rng.chance(0.2) ? 'CYCLING' : 'WALKING'
  if (isSummer(day) && d < 5_000 && rng.chance(0.15)) return 'CYCLING'
  if (d < 5_000) return rng.pick(['IN_SUBWAY', 'IN_SUBWAY', 'IN_BUS', 'IN_PASSENGER_VEHICLE', 'IN_TRAM'] as const)
  return rng.pick(['IN_PASSENGER_VEHICLE', 'IN_PASSENGER_VEHICLE', 'IN_SUBWAY', 'IN_BUS'] as const)
}

/** 行きに乗り物を使ったら帰りも同じ手段（車で出かけて地下鉄で帰ってくることはない） */
function sameOrCity(first: TravelMode | null, a: LatLon, b: LatLon, day: number, rng: Rng): TravelMode {
  return first && first !== 'WALKING' ? first : cityMode(a, b, day, rng)
}

/** 在宅勤務の割合。2020〜2021 年は多く、郊外の職場（車通勤）に移ってからは少ない */
function homeOfficeRate(w: World, day: number): number {
  if (day >= w.jobDay) return 0.1
  if (day < dayNumber('2020-04-01')) return 0.03
  if (day < dayNumber('2022-01-01')) return 0.55
  return 0.2
}

function workDay(it: Itinerary, day: number, w: World, rng: Rng): void {
  const home = homeAt(w, day)
  const work = workAt(w, day)
  const byCar = work === w.work2
  const commute: TravelMode = byCar
    ? rng.chance(0.9)
      ? 'IN_PASSENGER_VEHICLE'
      : 'IN_BUS'
    : isSummer(day) && rng.chance(0.1)
      ? 'CYCLING'
      : rng.chance(0.88)
        ? 'IN_SUBWAY'
        : 'IN_BUS'
  it.go(work, commute, at(day, JST, rng.range(7 * 60 + 15, 8 * 60 + 40)))

  if (rng.chance(0.45)) {
    it.go(rng.pick(lunchAt(w, day)), 'WALKING', at(day, JST, rng.range(11 * 60 + 50, 12 * 60 + 20)))
    it.go(work, 'WALKING', it.since + rng.range(30, 50) * 60)
  }

  let t = at(day, JST, rng.range(17 * 60 + 30, 19 * 60 + 30))
  const r = rng.float()
  let out: DemoPlace | null = null
  let stayMin = 0
  if (r < 0.15) [out, stayMin] = [rng.pick(w.restaurants), rng.range(75, 150)]
  else if (r < 0.27) [out, stayMin] = [gymAt(w, day), rng.range(60, 100)]
  else if (r < 0.31) [out, stayMin] = [rng.pick(w.friends), rng.range(120, 200)]
  else if (r < 0.45) [out, stayMin] = [superAt(w, day), rng.range(15, 30)]
  if (out) {
    // 車で通っている日は車のまま寄り道する
    it.go(out, commute === 'IN_PASSENGER_VEHICLE' ? commute : cityMode(it.place, out, day, rng), t)
    t = it.since + stayMin * 60
  }
  const back = it.place === work || commute === 'IN_PASSENGER_VEHICLE' ? commute : cityMode(it.place, home, day, rng)
  it.go(home, back, t)
}

function homeOfficeDay(it: Itinerary, day: number, w: World, rng: Rng): void {
  const home = homeAt(w, day)
  if (rng.chance(0.3)) {
    const cafe = rng.pick(w.cafes)
    const m = cityMode(home, cafe, day, rng)
    it.go(cafe, m, at(day, JST, rng.range(12 * 60, 12 * 60 + 30)))
    it.go(home, sameOrCity(m, cafe, home, day, rng), it.since + rng.range(40, 70) * 60)
  }
  if (rng.chance(0.4)) {
    const s = superAt(w, day)
    it.go(s, 'WALKING', at(day, JST, rng.range(17 * 60 + 30, 19 * 60)))
    it.go(home, 'WALKING', it.since + rng.range(15, 30) * 60)
  }
  if (isSummer(day) && rng.chance(0.15)) {
    const park = rng.pick(w.parks)
    const m = cityMode(home, park, day, rng)
    it.go(park, m, at(day, JST, rng.range(19 * 60, 20 * 60)))
    it.go(home, sameOrCity(m, park, home, day, rng), it.since + rng.range(40, 70) * 60)
  }
}

/** 小樽（約 35km）・旭川（約 140km）への日帰り。車か JR */
function dayTrip(it: Itinerary, day: number, spots: DemoPlace[], w: World, rng: Rng): void {
  const vehicle: TravelMode = rng.chance(0.6) ? 'IN_PASSENGER_VEHICLE' : 'IN_TRAIN'
  let t = at(day, JST, rng.range(8 * 60 + 30, 10 * 60))
  const n = rng.int(2, 3)
  for (let i = 0; i < n; i++) {
    const s = rng.pick(spots)
    const m = i === 0 ? vehicle : dist(it.place, s) < 1_500 ? 'WALKING' : vehicle === 'IN_TRAIN' ? 'IN_BUS' : vehicle
    it.go(s, m, t)
    t = it.since + rng.range(50, 130) * 60
  }
  it.go(homeAt(w, day), vehicle, Math.max(t, at(day, JST, rng.range(16 * 60, 18 * 60))))
}

function weekendDay(it: Itinerary, day: number, w: World, rng: Rng): void {
  const home = homeAt(w, day)
  let t = at(day, JST, rng.range(9 * 60, 11 * 60))
  let first: TravelMode | null = null
  const r = rng.float()

  if (r < 0.06) return dayTrip(it, day, w.otaru, w, rng)
  if (r < 0.09) return dayTrip(it, day, w.asahikawa, w, rng)

  if (r < 0.27) {
    // 公園。夏は自転車でも行く
    const park = rng.pick(w.parks)
    first = cityMode(home, park, day, rng)
    it.go(park, first, t)
    t = it.since + rng.range(60, 150) * 60
    if (rng.chance(0.5)) {
      const cafe = rng.pick(w.cafes)
      it.go(cafe, sameOrCity(first, park, cafe, day, rng), t)
      t = it.since + rng.range(40, 90) * 60
    }
  } else if (r < 0.45) {
    // モール。店（level 0）の親としてモール全体（level 1）の visit が重なる
    const shops = rng.pick(w.malls)
    first = rng.pick(['IN_PASSENGER_VEHICLE', 'IN_PASSENGER_VEHICLE', 'IN_BUS', 'IN_SUBWAY'] as const)
    it.go(rng.pick(shops), first, t)
    t = it.since + rng.range(60, 120) * 60
    if (rng.chance(0.5)) {
      it.go(rng.pick(shops), 'WALKING', t)
      t = it.since + rng.range(30, 90) * 60
    }
  } else if (r < 0.62) {
    // 街なかでカフェをはしご
    const cafe = rng.pick(w.cafes)
    first = cityMode(home, cafe, day, rng)
    it.go(cafe, first, t)
    t = it.since + rng.range(45, 100) * 60
    const next = rng.pick(rng.chance(0.5) ? w.cafes : w.restaurants)
    it.go(next, cityMode(cafe, next, day, rng), t)
    t = it.since + rng.range(40, 90) * 60
  } else if (r < 0.72) {
    const friend = rng.pick(w.friends)
    first = rng.chance(0.6) ? 'IN_PASSENGER_VEHICLE' : 'IN_BUS'
    it.go(friend, first, at(day, JST, rng.range(13 * 60, 15 * 60)))
    t = it.since + rng.range(180, 300) * 60
  } else {
    // 家で過ごす。夕方に買い物だけ
    const s = superAt(w, day)
    it.go(s, 'WALKING', at(day, JST, rng.range(15 * 60, 17 * 60)))
    t = it.since + rng.range(20, 40) * 60
  }

  if (rng.chance(0.25)) {
    const rest = rng.pick(w.restaurants)
    it.go(rest, sameOrCity(first, it.place, rest, day, rng), Math.max(t, at(day, JST, rng.range(18 * 60, 19 * 60 + 30))))
    t = it.since + rng.range(70, 130) * 60
  }
  it.go(home, sameOrCity(first, it.place, home, day, rng), t)
}

/** 旅先の 1 日。宿を出て 2〜4 か所回り、夕方に宿へ戻る */
function sightseeingDay(
  it: Itinerary,
  day: number,
  d: Destination,
  spots: DemoPlace[],
  commute: TravelMode | null,
  rng: Rng,
): void {
  const local = (a: LatLon, b: LatLon): TravelMode => (dist(a, b) < 1_500 ? 'WALKING' : d.far)
  let t = at(day, d.tz, rng.range(9 * 60, 10 * 60 + 30))
  const n = rng.int(2, 4)
  for (let i = 0; i < n; i++) {
    const s = rng.pick(spots)
    it.go(s, i === 0 && commute ? commute : local(it.place, s), t)
    t = it.since + rng.range(60, 150) * 60
  }
  it.go(d.hotel, commute ?? local(it.place, d.hotel), Math.max(t, at(day, d.tz, rng.range(17 * 60, 20 * 60))))
}

/** 泊まりがけの旅行。空港までは電車（車を持ってからは車のことも）、空港間は飛行機 */
function tripPlan(it: Itinerary, startDay: number, nights: number, d: Destination, w: World, rng: Rng): void {
  const toAirport: TravelMode = startDay >= w.jobDay && rng.chance(0.4) ? 'IN_PASSENGER_VEHICLE' : 'IN_TRAIN'
  it.go(w.cts, toAirport, at(startDay, JST, rng.range(7 * 60, 10 * 60)))
  let depart = it.since + rng.range(50, 90) * 60
  if (d.viaHaneda) {
    it.fly(w.hnd, depart, 95)
    depart = it.since + rng.range(120, 180) * 60
  }
  it.fly(d.airport, depart, d.flightMin)
  it.go(d.hotel, d.access, it.since + rng.range(20, 45) * 60)

  const arrivalDay = dayOf(it.since, d.tz)
  // 早く着いた日は、夕方に宿の近くへ食事に出る
  if (it.since < at(arrivalDay, d.tz, 18 * 60)) {
    const s = rng.pick(d.spots)
    it.go(s, dist(d.hotel, s) < 1_500 ? 'WALKING' : d.far, at(arrivalDay, d.tz, rng.range(18 * 60, 19 * 60)))
    it.go(d.hotel, dist(d.hotel, s) < 1_500 ? 'WALKING' : d.far, it.since + rng.range(60, 100) * 60)
  }
  for (let k = 1; k < nights; k++) {
    if (k === 1 && d.side) sightseeingDay(it, arrivalDay + k, d, d.side.spots, d.side.mode, rng)
    else sightseeingDay(it, arrivalDay + k, d, d.spots, null, rng)
  }

  // 最終日: 午前に 1 か所寄ってから空港へ
  const lastDay = arrivalDay + nights
  let t = at(lastDay, d.tz, rng.range(9 * 60, 10 * 60 + 30))
  if (rng.chance(0.6)) {
    const s = rng.pick(d.spots)
    it.go(s, dist(it.place, s) < 1_500 ? 'WALKING' : d.far, t)
    t = it.since + rng.range(60, 120) * 60
  }
  it.go(d.airport, d.access, Math.max(t, at(lastDay, d.tz, rng.range(11 * 60 + 30, 14 * 60))))
  depart = it.since + rng.range(60, 100) * 60
  if (d.viaHaneda) {
    it.fly(w.hnd, depart, d.flightMin - 20)
    depart = it.since + rng.range(120, 200) * 60
    it.fly(w.cts, depart, 95)
  } else {
    it.fly(w.cts, depart, d.flightMin)
  }
  it.go(homeAt(w, dayOf(it.since, JST)), toAirport, it.since + rng.range(15, 30) * 60)
}

interface Memory {
  start: number
  end: number
  hotel: DemoPlace
  km: number
}

function planLife(w: World, startDay: number, endDay: number, rng: Rng): { items: Item[]; memories: Memory[] } {
  const trips = new Map<number, readonly [DestKey, number]>()
  for (const [date, key, nights] of TRIPS) {
    const d = dayNumber(date)
    // 帰りが期間の外にはみ出す旅行は出さない（途中で切れた旅は見本として紛らわしい）
    if (d >= startDay && d + nights + 2 <= endDay) trips.set(d, [key, nights])
  }

  const it = new Itinerary(homeAt(w, startDay), at(startDay, JST, 0), rng)
  const memories: Memory[] = []

  let day = startDay
  while (day <= endDay) {
    const trip = trips.get(day)
    if (trip) {
      const d = w.dest[trip[0]]
      const first = it.items.length
      tripPlan(it, day, trip[1], d, w, rng)
      // tripPlan が最初に積むのは「家に居た滞在」で、その終わりが出発時刻
      const start = it.items[first].end
      memories.push({ start, end: it.since, hotel: d.hotel, km: Math.round(dist(homeAt(w, day), d.hotel) / 1000) })
      // 帰ってきた日の翌日から普段の暮らしに戻る
      day = Math.max(day + 1, dayOf(it.since, JST) + 1)
      continue
    }
    const wd = weekday(day)
    if (wd === 0 || wd === 6 || isHoliday(day)) weekendDay(it, day, w, rng)
    else if (rng.chance(homeOfficeRate(w, day))) homeOfficeDay(it, day, w, rng)
    else workDay(it, day, w, rng)
    day += 1
  }
  it.close(at(endDay + 1, JST, 0) - 1)
  return { items: it.items, memories }
}

// ---------------------------------------------------------------
// 2. スマホが記録した点
// ---------------------------------------------------------------

interface Obs extends LatLon {
  t: number
  tz: number
}

/**
 * 移動中は 20〜60 秒おき、じっとしている間は 55〜200 分おきに点を打つ。
 * 滞在中の点が疎らなので、そこで軌跡が切れて「隙間」ができる。古い年の滞在は、
 * この隙間から復元される（core/visits.ts）。夜中（0〜6 時）はほとんど記録しない。
 * 飛行中は記録しない。前後の空港の点を後段が大圏で橋渡しする（core/trips.ts の bridgeFlights）。
 */
function observe(items: Item[], rng: Rng): Obs[] {
  const out: Obs[] = []
  for (const item of items) {
    if (item.kind === 'leg') {
      if (item.mode === 'FLYING') continue
      const cum = [0]
      for (let i = 1; i < item.path.length; i++) cum.push(cum[i - 1] + dist(item.path[i - 1], item.path[i]))
      const total = cum[cum.length - 1]
      const dur = item.end - item.start
      let seg = 1
      for (let t = item.start + rng.int(5, 30); t < item.end; t += rng.int(20, 60)) {
        const target = ((t - item.start) / dur) * total
        while (seg < cum.length - 1 && cum[seg] < target) seg++
        const len = cum[seg] - cum[seg - 1]
        const g = len > 0 ? (target - cum[seg - 1]) / len : 0
        const a = item.path[seg - 1]
        const b = item.path[seg]
        const p = jitter({ lat: a.lat + (b.lat - a.lat) * g, lon: a.lon + (b.lon - a.lon) * g }, 12, rng)
        out.push({ t, lat: p.lat, lon: p.lon, tz: item.from.tz })
      }
      const p = jitter(item.to, 10, rng)
      out.push({ t: item.end, lat: p.lat, lon: p.lon, tz: item.to.tz })
    } else {
      const tz = item.place.tz
      for (let t = item.start + rng.int(55, 200) * 60; t < item.end - 300; t += rng.int(55, 200) * 60) {
        if (localHour(t, tz) < 7 && !rng.chance(0.1)) continue
        const p = jitter(item.place, 10, rng)
        out.push({ t, lat: p.lat, lon: p.lon, tz })
      }
    }
  }
  return out
}

interface Bucket {
  start: number
  tz: number
  points: Obs[]
}

/**
 * 点を 2 時間バケット（記録側の現地時刻で偶数時ちょうどに始まる）に分け、
 * denseFrom より前だけ間引く。バケットを丸ごと落とすのは「その時間帯ごと記録が無い」、
 * バケット内の点を落とすのは「点が粗い」の再現（DESIGN.md §8 D の間引きと同じ 2 段構え）。
 */
function toBuckets(obs: Obs[], denseFrom: number, outage: [number, number], rng: Rng): Bucket[] {
  const byKey = new Map<string, Bucket>()
  for (const p of obs) {
    const start = Math.floor((p.t + p.tz * 60) / BUCKET_SEC) * BUCKET_SEC - p.tz * 60
    const key = `${p.tz}:${start}`
    let b = byKey.get(key)
    if (!b) byKey.set(key, (b = { start, tz: p.tz, points: [] }))
    b.points.push(p)
  }

  const dayOff = new Map<number, boolean>()
  const kept: Bucket[] = []
  for (const b of byKey.values()) {
    if (b.start >= denseFrom) {
      kept.push(b)
      continue
    }
    const day = dayOf(b.start, b.tz)
    if (day >= outage[0] && day <= outage[1]) continue
    let off = dayOff.get(day)
    if (off === undefined) dayOff.set(day, (off = rng.chance(OLD_DAY_OFF)))
    if (off || !rng.chance(OLD_BUCKET_KEEP)) continue
    const points = b.points.filter(() => rng.chance(OLD_POINT_KEEP))
    if (points.length > 0) kept.push({ start: b.start, tz: b.tz, points })
  }
  return kept
}

// ---------------------------------------------------------------
// 3. Google の形式に書き出す
// ---------------------------------------------------------------

function semanticTypeOf(p: DemoPlace, rng: Rng): string {
  // Google は自宅・職場でも INFERRED_* を付けることがある（実データで HOME 43 件に対し INFERRED_HOME 301 件）
  if (p.kind === 'home') return rng.chance(0.8) ? 'HOME' : 'INFERRED_HOME'
  if (p.kind === 'work') return rng.chance(0.75) ? 'WORK' : 'INFERRED_WORK'
  // 検索して行った住所は旅先だけにする。近所のスーパーに 1 回でも付くと、
  // 場所の種別は強い方で上書きされる（core/aggregate.ts の TYPE_RANK）ので、何百回も通う店が「検索した住所」になる
  if (p.kind === 'away') return rng.chance(0.05) ? 'SEARCHED_ADDRESS' : 'UNKNOWN'
  return 'UNKNOWN'
}

function visitSegment(s: Stay, place: DemoPlace, level: 0 | 1, rng: Rng): RawSegment {
  const tz = s.place.tz
  return {
    startTime: iso(s.start, tz),
    endTime: iso(s.end, tz),
    startTimeTimezoneUtcOffsetMinutes: tz,
    endTimeTimezoneUtcOffsetMinutes: tz,
    visit: {
      hierarchyLevel: level,
      probability: r3(rng.range(0.55, 0.98)),
      topCandidate: {
        placeId: place.id,
        semanticType: level === 0 ? semanticTypeOf(place, rng) : 'UNKNOWN',
        probability: r3(rng.range(0.3, 0.95)),
        placeLocation: { latLng: latLng(place) },
      },
    },
  }
}

function activitySegment(l: Leg, rng: Rng): RawSegment {
  const seg: RawSegment = {
    startTime: iso(l.start, l.from.tz),
    endTime: iso(l.end, l.to.tz),
    startTimeTimezoneUtcOffsetMinutes: l.from.tz,
    endTimeTimezoneUtcOffsetMinutes: l.to.tz,
    activity: {
      start: { latLng: latLng(l.from) },
      end: { latLng: latLng(l.to) },
      distanceMeters: Math.round(l.meters),
      probability: r3(rng.range(0.8, 0.99)),
      topCandidate: { type: l.mode, probability: r3(rng.range(0.5, 0.97)) },
    },
  }
  if (l.mode === 'IN_PASSENGER_VEHICLE' && seg.activity) {
    seg.activity.parking = { location: { latLng: latLng(jitter(l.to, 25, rng)) }, startTime: iso(l.end - 60, l.to.tz) }
  }
  return seg
}

export function generateDemoHistory(seed: number = DEMO_SEED, options: DemoOptions = {}): DemoHistory {
  const startDay = dayNumber(options.start ?? DEFAULT_START)
  const endDay = dayNumber(options.end ?? DEFAULT_END)
  if (endDay < startDay) throw new Error('デモデータの期間: end が start より前です')

  // 用途ごとに乱数の列を分ける。場所の配置は期間を縮めても変わらない
  const world = buildWorld(new Rng(seed))
  const { items, memories } = planLife(world, startDay, endDay, new Rng(seed ^ 0x51ed270b))
  const obsRng = new Rng(seed ^ 0x2c1b3c6d)
  const obs = observe(items, obsRng)
  const denseFrom = at(dayNumber(DEMO_DENSE_FROM), JST, 0)
  const buckets = toBuckets(obs, denseFrom, [dayNumber(OUTAGE_FROM), dayNumber(OUTAGE_TO)], obsRng)

  const segRng = new Rng(seed ^ 0x7feb352d)
  const out: Array<{ t: number; seg: RawSegment }> = []
  for (const b of buckets) {
    out.push({
      t: b.start,
      seg: {
        startTime: iso(b.start, b.tz),
        endTime: iso(b.start + BUCKET_SEC, b.tz),
        startTimeTimezoneUtcOffsetMinutes: b.tz,
        endTimeTimezoneUtcOffsetMinutes: b.tz,
        timelinePath: b.points.map((p) => ({ point: latLng(p), time: iso(p.t, b.tz) })),
      },
    })
  }

  // visit / activity は Google が端末内処理に移ってからしか無い（DESIGN.md §1.2）
  for (const item of items) {
    if (item.start < denseFrom) continue
    if (item.kind === 'leg') {
      out.push({ t: item.start, seg: activitySegment(item, segRng) })
      continue
    }
    // 数分の立ち寄りは Google も visit にしない
    if (item.end - item.start < 5 * 60) continue
    out.push({ t: item.start, seg: visitSegment(item, item.place, 0, segRng) })
    // 実データの hierarchyLevel 1 は、ほぼすべてが level 0 の訪問と時間が重なる親施設（DESIGN.md §1.3）
    if (item.place.parent) out.push({ t: item.start, seg: visitSegment(item, item.place.parent, 1, segRng) })
  }

  // 旅行のまとまり。アプリは件数を数えるだけ
  for (const m of memories) {
    if (m.start < denseFrom) continue
    out.push({
      t: m.start,
      seg: {
        startTime: iso(m.start, JST),
        endTime: iso(m.end, JST),
        startTimeTimezoneUtcOffsetMinutes: JST,
        endTimeTimezoneUtcOffsetMinutes: JST,
        timelineMemory: { trip: { distanceFromOriginKms: m.km, destinations: [{ identifier: { placeId: m.hotel.id } }] } },
      },
    })
  }

  // 実ファイルと同じく時刻順に並べる（同時刻なら積んだ順＝パス → 訪問 level 0 → level 1）
  out.sort((a, b) => a.t - b.t)

  const home = homeAt(world, endDay)
  const work = workAt(world, endDay)
  return {
    semanticSegments: out.map((x) => x.seg),
    userLocationProfile: {
      frequentPlaces: [
        { placeId: home.id, placeLocation: latLng(home), label: 'HOME' },
        { placeId: work.id, placeLocation: latLng(work), label: 'WORK' },
      ],
    },
  }
}
