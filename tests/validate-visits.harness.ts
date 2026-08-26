/**
 * 滞在復元パラメータ（R / T）の検証ハーネス。DESIGN.md 未決事項 D。
 *
 * ふつうのテストではない。実データを読んで表を出す計測ツールで、
 * `npm run validate:visits` でだけ走る（`npm test` の include には入っていない）。
 * ランナーに vitest を使っているのは、追加の依存なしで src/ の TypeScript を
 * そのまま呼べるから。アプリと同じ関数を通すこと自体が要件でもある
 * （ハーネスが独自に読むと「アプリと違う読み方」を測ってしまう）。
 *
 * 何を測るか:
 *   2024 年秋以降は Google の visit があるので「正解」が手に入る。しかし
 *   その期間は記録が濃い（約 15.5 h/日）ので、そこで最適な R / T を選んでも
 *   2019 年（約 6.2 h/日）には転用できない。そこで
 *   **濃い年の timelinePath を 2019 年の密度まで間引いてから復元し、
 *   同じ期間の Google visit と突き合わせる**。
 *   これで「2019 年の密度なら何が復元できるか」が測れる。
 *
 * 出力は Markdown の表。DESIGN.md にそのまま貼れる形にしてある。
 * 出すのは件数・割合・距離の統計だけで、座標や地名は出さない（DESIGN.md §9）。
 */
import { existsSync, createReadStream } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { JSONParser } from '@streamparser/json'
import { createSegmentCollector } from '../src/core/segments'
import type { RawProfile, RawSegment } from '../src/core/segments'
import { buildTrips } from '../src/core/trips'
import { deriveVisitsFromTrips } from '../src/core/visits'
import { haversineMeters, localDayKey } from '../src/core/geo'
import type { TrackPoint, Trip, Visit, YearCoverage } from '../src/core/types'

const SAMPLE = 'Sampledata/location-history.json'

/** 正解（Google visit）がある濃い年。ここを間引いて評価する。 */
const EVAL_YEAR = 2025
/** 再現したい密度の年。 */
const REF_YEAR = 2019
/** 記録側のタイムゾーン（バケットを現地時間の 2 時間境界に合わせるためだけに使う）。 */
const TZ_MIN = 540
/** timelinePath のバケット幅（秒）。DESIGN.md §1.2.1。 */
const BUCKET_SEC = 7200

/**
 * 正解の滞在を「復元できた」とみなす重なりの割合。
 *
 * 数字を見てから決めると何とでも言えるので、先に決めて書いておく:
 * - 再現率: 正解の滞在の **長さの 50% 以上** に重なる derived があれば復元できたとする。
 * - 適合率（時間）: derived の **自分の長さの 50% 以上** が何らかの正解に重なっていれば当たり。
 * - 適合率（位置込み）: 上に加えて、その正解との距離が 250m 以内であること。
 *   時間だけで見ると「時間帯は合っているが場所が違う」復元を当たりに数えてしまい、
 *   距離ゲートの有無が適合率に出てこない。実際そうなったので列を分けてある。
 * - 位置誤差: 最も長く重なった derived の座標と、正解の座標の距離。
 */
const MIN_OVERLAP_RATIO = 0.5
/** 適合率（位置込み）で「同じ場所」とみなす距離。場所集約のグリッド 100m より少し緩く。 */
const HIT_METERS = 250

const TS = [900, 1500, 1800, 3600, 7200] as const
const RS = [60, 120, 250, 500, 1000, 2000, Number.POSITIVE_INFINITY] as const

// --- データ読み込み -----------------------------------------------------------

async function loadSample() {
  const collector = createSegmentCollector()
  const parser = new JSONParser({
    paths: ['$.semanticSegments.*', '$.userLocationProfile'],
    keepStack: false,
    stringBufferSize: 64 * 1024,
  })
  parser.onValue = ({ value, key, stack }) => {
    const container = stack.length === 2 ? stack[1]?.key : undefined
    if (container === 'semanticSegments') {
      collector.ingestSegment(value as unknown as RawSegment)
      return
    }
    if (stack.length === 1 && key === 'userLocationProfile') {
      collector.ingestProfile(value as unknown as RawProfile)
    }
  }
  for await (const chunk of createReadStream(SAMPLE)) parser.write(chunk as Uint8Array)
  try {
    parser.end()
  } catch {
    // ルート値が閉じた時点でパーサは終了済み。Worker 側と同じ扱い。
  }
  return collector.result()
}

// --- 密度の計測と間引き -------------------------------------------------------

/** 現地時間の 2 時間境界に合わせたバケット ID。 */
function bucketId(t: number): number {
  return Math.floor((t + TZ_MIN * 60) / BUCKET_SEC)
}

function yearOf(t: number): number {
  return Number(localDayKey(t, TZ_MIN).slice(0, 4))
}

interface Density {
  year: number
  days: number
  buckets: number
  points: number
  bucketsPerDay: number
  pointsPerBucket: number
  hoursPerDay: number
}

function densityOf(points: TrackPoint[], year: number): Density {
  const days = new Set<string>()
  const buckets = new Set<number>()
  let n = 0
  for (const p of points) {
    if (yearOf(p.t) !== year) continue
    days.add(localDayKey(p.t, TZ_MIN))
    buckets.add(bucketId(p.t))
    n += 1
  }
  const d = days.size || 1
  const b = buckets.size || 1
  return {
    year,
    days: days.size,
    buckets: buckets.size,
    points: n,
    bucketsPerDay: buckets.size / d,
    pointsPerBucket: n / b,
    hoursPerDay: (buckets.size * (BUCKET_SEC / 3600)) / d,
  }
}

/** 決定的な擬似乱数（seed 固定。同じ入力なら毎回同じ間引き結果になる）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 濃い年の点列を、薄い年の密度まで落とす。
 *
 * 2 段構えなのは、薄さの中身が 2 種類あるから:
 *   1. その時間帯ごと記録が無い（バケットが存在しない）
 *   2. 記録はあるが点が粗い（バケットあたりの点が少ない）
 * 点を一様に間引くだけでは 1 を再現できず、隙間の出方が本物と変わってしまう。
 */
function thinToDensity(points: TrackPoint[], from: Density, to: Density, seed = 20190101) {
  const rnd = mulberry32(seed)
  const keepBucket = Math.min(1, to.bucketsPerDay / from.bucketsPerDay)
  const keepPoint = Math.min(1, to.pointsPerBucket / from.pointsPerBucket)

  const decided = new Map<number, boolean>()
  const kept: TrackPoint[] = []
  for (const p of points) {
    if (yearOf(p.t) !== from.year) continue
    const b = bucketId(p.t)
    let alive = decided.get(b)
    if (alive === undefined) {
      alive = rnd() < keepBucket
      decided.set(b, alive)
    }
    if (!alive) continue
    if (rnd() >= keepPoint) continue
    kept.push(p)
  }
  return { points: kept, keepBucket, keepPoint }
}

// --- 評価 ---------------------------------------------------------------------

function overlapSec(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
}

function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

interface Score {
  derived: number
  recalled: number
  recall: number
  precisionTime: number
  precisionPlace: number
  posErrMedian: number
  posErrP75: number
  durRatioMedian: number
}

function score(derived: Visit[], truth: Visit[]): Score {
  let recalled = 0
  const posErr: number[] = []
  const durRatio: number[] = []

  for (const g of truth) {
    const gLen = g.end - g.start
    let best: Visit | undefined
    let bestOv = 0
    for (const d of derived) {
      const ov = overlapSec(g, d)
      if (ov > bestOv) {
        bestOv = ov
        best = d
      }
    }
    if (best && gLen > 0 && bestOv / gLen >= MIN_OVERLAP_RATIO) {
      recalled += 1
      posErr.push(haversineMeters(best.lat, best.lon, g.lat, g.lon))
      durRatio.push((best.end - best.start) / gLen)
    }
  }

  let hitsTime = 0
  let hitsPlace = 0
  for (const d of derived) {
    const dLen = d.end - d.start
    if (dLen <= 0) continue
    let bestOv = 0
    let best: Visit | undefined
    for (const g of truth) {
      const ov = overlapSec(g, d)
      if (ov > bestOv) {
        bestOv = ov
        best = g
      }
    }
    if (bestOv / dLen < MIN_OVERLAP_RATIO) continue
    hitsTime += 1
    if (best && haversineMeters(d.lat, d.lon, best.lat, best.lon) <= HIT_METERS) hitsPlace += 1
  }

  return {
    derived: derived.length,
    recalled,
    recall: truth.length ? recalled / truth.length : 0,
    precisionTime: derived.length ? hitsTime / derived.length : 0,
    precisionPlace: derived.length ? hitsPlace / derived.length : 0,
    posErrMedian: median(posErr),
    posErrP75: posErr.length
      ? [...posErr].sort((a, b) => a - b)[Math.floor(posErr.length * 0.75)]!
      : Number.NaN,
    durRatioMedian: median(durRatio),
  }
}

/**
 * 復元を走らせる。
 *
 * 正解（Google visit）は入力から意図的に外す: existingVisits を空にし、
 * coverage は全年 hasGoogleVisits: false にする。そうしないと
 * 「Google のデータがある年は復元しない」規則で何も出ない。
 * coverage は UTC 暦年で引かれる（deriveVisitsFromTrips 側）ので、
 * 現地時間の年ズレを踏まないよう前後の年まで埋めておく。
 */
function derive(trips: Trip[], t: number, r: number): Visit[] {
  const coverage: YearCoverage[] = []
  for (let y = EVAL_YEAR - 2; y <= EVAL_YEAR + 2; y++) {
    coverage.push({ year: y, recordedDays: 300, coverageHoursPerDay: 6, hasGoogleVisits: false })
  }
  return deriveVisitsFromTrips(trips, [], coverage, t, r)
}

function pct(x: number): string {
  return Number.isNaN(x) ? '-' : `${(x * 100).toFixed(0)}%`
}

function meters(x: number): string {
  return Number.isNaN(x) ? '-' : `${Math.round(x)}m`
}

// --- 本体 ---------------------------------------------------------------------

const hasSample = existsSync(SAMPLE)

describe.skipIf(!hasSample)('滞在復元パラメータの検証（未決事項 D）', () => {
  it(
    '濃い年を薄い年の密度まで間引いて、R / T を振って復元精度を測る',
    { timeout: 600_000 },
    async () => {
      const collected = await loadSample()
      expect(collected.counts.segments).toBeGreaterThan(0)

      const dense = densityOf(collected.points, EVAL_YEAR)
      const sparse = densityOf(collected.points, REF_YEAR)
      expect(dense.points).toBeGreaterThan(0)
      expect(sparse.points).toBeGreaterThan(0)

      const lines: string[] = []
      const say = (s = '') => {
        lines.push(s)
      }

      say('## 記録の密度（現地時間で集計）')
      say()
      say('| 年 | 記録日 | バケット/日 | 点/バケット | 点/日 | 時間/日 |')
      say('|---|---|---|---|---|---|')
      for (const d of [sparse, dense]) {
        say(
          `| ${d.year} | ${d.days} | ${d.bucketsPerDay.toFixed(1)} | ` +
            `${d.pointsPerBucket.toFixed(1)} | ${(d.points / (d.days || 1)).toFixed(1)} | ` +
            `${d.hoursPerDay.toFixed(1)} h |`,
        )
      }

      const thinned = thinToDensity(collected.points, dense, sparse)
      const thinnedDensity = densityOf(thinned.points, EVAL_YEAR)
      say()
      say(
        `間引き: バケットを ${(thinned.keepBucket * 100).toFixed(0)}%、` +
          `残ったバケット内の点を ${(thinned.keepPoint * 100).toFixed(0)}% 残す。` +
          `結果 ${dense.points} 点 → ${thinned.points.length} 点` +
          `（${thinnedDensity.bucketsPerDay.toFixed(1)} バケット/日、` +
          `${thinnedDensity.pointsPerBucket.toFixed(1)} 点/バケット、` +
          `${thinnedDensity.hoursPerDay.toFixed(1)} h/日）`,
      )

      // 評価期間は「間引いた年」。飛行区間は大圏補間の合成点なので評価から外す。
      const full = buildTrips(collected.points.filter((p) => yearOf(p.t) === EVAL_YEAR))
      const thin = buildTrips(thinned.points)
      const flightRanges = [...full.trips, ...thin.trips]
        .filter((t) => t.isFlight)
        .map((t) => ({ start: t.tStart, end: t.tEnd }))
      const inFlight = (v: { start: number; end: number }) =>
        flightRanges.some((f) => overlapSec(f, v) > 0)

      const truth = collected.visits.filter(
        (v) =>
          v.hierarchyLevel === 0 &&
          v.source === 'google' &&
          yearOf(v.start) === EVAL_YEAR &&
          !inFlight(v),
      )
      expect(truth.length).toBeGreaterThan(0)

      say()
      say(
        `評価期間 ${EVAL_YEAR} 年: 正解の滞在 ${truth.length} 件` +
          `（hierarchyLevel 0・飛行区間を除く）、` +
          `軌跡は間引き後 ${thin.trips.length} 本（間引き前 ${full.trips.length} 本）。`,
      )
      say(
        `判定基準: 正解の長さの ${MIN_OVERLAP_RATIO * 100}% 以上に重なれば復元成功。` +
          `適合率は derived 側の長さの ${MIN_OVERLAP_RATIO * 100}% 以上が正解に重なった割合で、` +
          `「位置込み」はさらにその正解との距離が ${HIT_METERS}m 以内のもの。`,
      )
      say(
        '注: 軌跡は 30 分以上の空白で切ってあるので、隙間は必ず 30 分以上ある。' +
          'T を 30 分より短くしても結果は変わらない（表の 15 分 / 25 分 / 30 分が同じ行になる）。',
      )

      const table = (trips: Trip[], label: string) => {
        say()
        say(`### ${label}`)
        say()
        say(
          '| T（最短滞在） | R（許容移動） | 復元件数 | 再現率 | 適合率（時間） | ' +
            `適合率（${HIT_METERS}m 以内） | 位置誤差 中央 | 同 p75 | 滞在時間比 中央 |`,
        )
        say('|---|---|---|---|---|---|---|---|---|')
        for (const t of TS) {
          for (const r of RS) {
            const d = derive(trips, t, r).filter((v) => !inFlight(v))
            const s = score(d, truth)
            const rLabel = Number.isFinite(r) ? `${r}m` : '∞（無効化）'
            say(
              `| ${t / 60}分 | ${rLabel} | ${s.derived} | ${pct(s.recall)} | ` +
                `${pct(s.precisionTime)} | ${pct(s.precisionPlace)} | ` +
                `${meters(s.posErrMedian)} | ${meters(s.posErrP75)} | ` +
                `${Number.isNaN(s.durRatioMedian) ? '-' : s.durRatioMedian.toFixed(2)} |`,
            )
          }
        }
      }

      table(thin.trips, `${REF_YEAR} 年の密度まで間引いた ${EVAL_YEAR} 年（本命）`)
      table(full.trips, `参考: 間引かない ${EVAL_YEAR} 年（記録が濃いまま）`)

      say()
      console.log('\n' + lines.join('\n') + '\n')
    },
  )
})
