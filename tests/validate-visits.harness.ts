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

/** T の掃引（R は既定に固定して振る）。効かないことの確認用なので粗くてよい。 */
const TS = [900, 1500, 1800, 3600, 7200] as const
/** R の掃引（T は分割閾値の 30 分に固定して振る）。最適値を探すので細かく。 */
const RS = [
  40, 60, 80, 100, 120, 150, 175, 200, 250, 300, 350, 400, 500, 650, 800, 1000, 1500, 2000,
  Number.POSITIVE_INFINITY,
] as const

/**
 * 間引きの乱数シード。
 * 1 回の間引き結果に最適値が引っ張られないよう複数回まわして平均で見る。
 * どのバケットが落ちるかで隙間の出方は変わるので、1 本だけだとその形に過適合する。
 */
const SEEDS = Array.from({ length: 25 }, (_, i) => 20190101 + i * 7919)

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
  /** 位置込みの再現率。時間が重なるだけでなく、場所も HIT_METERS 以内で当たった割合。 */
  recallPlace: number
  /** 位置込みの再現率と適合率の F1。R の最適値はこれで決める。 */
  f1Place: number
  precisionTime: number
  precisionPlace: number
  /** 位置まで当たった derived の件数。R を緩めたときの「増えた分の質」を見るのに使う。 */
  correct: number
  /** 当たりと確認できなかった derived の件数（= 復元件数 − 当たり）。 */
  wrong: number
  posErrMedian: number
  posErrP75: number
  durRatioMedian: number
  /** 「復元した」ことになった正解 ÷ それを担った derived の件数。1.0 なら 1 対 1。 */
  absorbMean: number
  /** 同上の最大。 */
  absorbMax: number
}

function score(derived: Visit[], truth: Visit[]): Score {
  let recalled = 0
  let recalledPlace = 0
  const posErr: number[] = []
  const durRatio: number[] = []

  // 「どの derived が何件の正解を復元したことになったか」も数える。
  // 長い隙間を 1 件の derived にすると、その中の短い正解を丸ごと覆うので
  // 再現率だけ上がる。その水増しが見えるようにしておく。
  const absorbed = new Map<number, number>()

  for (const g of truth) {
    const gLen = g.end - g.start
    let bestIdx = -1
    let bestOv = 0
    for (let i = 0; i < derived.length; i++) {
      const ov = overlapSec(g, derived[i]!)
      if (ov > bestOv) {
        bestOv = ov
        bestIdx = i
      }
    }
    const best = bestIdx >= 0 ? derived[bestIdx]! : undefined
    if (best && gLen > 0 && bestOv / gLen >= MIN_OVERLAP_RATIO) {
      recalled += 1
      const err = haversineMeters(best.lat, best.lon, g.lat, g.lon)
      posErr.push(err)
      durRatio.push((best.end - best.start) / gLen)
      absorbed.set(bestIdx, (absorbed.get(bestIdx) ?? 0) + 1)
      if (err <= HIT_METERS) recalledPlace += 1
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

  const recallPlace = truth.length ? recalledPlace / truth.length : 0
  const precisionPlace = derived.length ? hitsPlace / derived.length : 0

  return {
    derived: derived.length,
    recalled,
    recall: truth.length ? recalled / truth.length : 0,
    recallPlace,
    f1Place:
      recallPlace + precisionPlace > 0
        ? (2 * recallPlace * precisionPlace) / (recallPlace + precisionPlace)
        : 0,
    precisionTime: derived.length ? hitsTime / derived.length : 0,
    precisionPlace,
    correct: hitsPlace,
    wrong: derived.length - hitsPlace,
    posErrMedian: median(posErr),
    posErrP75: posErr.length
      ? [...posErr].sort((a, b) => a - b)[Math.floor(posErr.length * 0.75)]!
      : Number.NaN,
    durRatioMedian: median(durRatio),
    absorbMean: absorbed.size ? recalled / absorbed.size : 0,
    absorbMax: absorbed.size ? Math.max(...absorbed.values()) : 0,
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

      // 間引きはシードごとに 1 本ずつ。どのバケットが落ちるかで隙間の出方が変わるので、
      // 1 本だけで最適値を決めるとその形に過適合する。
      const runs = SEEDS.map((seed) => {
        const thinned = thinToDensity(collected.points, dense, sparse, seed)
        return { seed, thinned, trips: buildTrips(thinned.points).trips }
      })
      const first = runs[0]!
      const thinnedDensity = densityOf(first.thinned.points, EVAL_YEAR)
      say()
      say(
        `間引き: バケットを ${(first.thinned.keepBucket * 100).toFixed(0)}%、` +
          `残ったバケット内の点を ${(first.thinned.keepPoint * 100).toFixed(0)}% 残す。` +
          `結果 ${dense.points} 点 → ${first.thinned.points.length} 点` +
          `（${thinnedDensity.bucketsPerDay.toFixed(1)} バケット/日、` +
          `${thinnedDensity.pointsPerBucket.toFixed(1)} 点/バケット、` +
          `${thinnedDensity.hoursPerDay.toFixed(1)} h/日）。` +
          `これをシードを変えて ${SEEDS.length} 本作り、表の数字は平均。`,
      )

      // 評価期間は「間引いた年」。飛行区間は大圏補間の合成点なので評価から外す。
      const full = buildTrips(collected.points.filter((p) => yearOf(p.t) === EVAL_YEAR))
      const flightRanges = [...full.trips, ...runs.flatMap((r) => r.trips)]
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
          `軌跡は間引き後 ${first.trips.length} 本（間引き前 ${full.trips.length} 本）。`,
      )
      say(
        `判定基準: 正解の長さの ${MIN_OVERLAP_RATIO * 100}% 以上に重なれば復元成功。` +
          `適合率は derived 側の長さの ${MIN_OVERLAP_RATIO * 100}% 以上が正解に重なった割合で、` +
          `「位置込み」はさらにその正解との距離が ${HIT_METERS}m 以内のもの。`,
      )
      say(
        '注: 軌跡は trips.ts の DEFAULT_GAP_SEC（30 分）以上の空白で切ってあるので、' +
          '隙間は必ず 30 分以上ある。T をその閾値より短くしても結果は変わらない' +
          '（表の 15 分 / 25 分 / 30 分が同じ行になる）。これはデータの性質ではなく' +
          '分割閾値との関係なので、閾値を変えれば下限も動く。',
      )
      say(
        '「吸収」は復元できた正解 ÷ それを担った derived の件数（平均 / 最大）。' +
          '1.0 なら 1 対 1。長い隙間を 1 件の derived にすると中の短い滞在をまとめて覆うので、' +
          '場所が合っていなくても再現率だけが上がる。再現率はこの数字とセットで読む。',
      )

      /** 同じ (T, R) を全シードで測って平均する。tripSets が 1 本なら平均は素の値。 */
      const meanScore = (tripSets: Trip[][], t: number, r: number) => {
        const ss = tripSets.map((trips) => score(derive(trips, t, r).filter((v) => !inFlight(v)), truth))
        const avg = (pick: (s: Score) => number) =>
          ss.reduce((a, s) => a + (Number.isNaN(pick(s)) ? 0 : pick(s)), 0) / ss.length
        return {
          derived: avg((s) => s.derived),
          recall: avg((s) => s.recall),
          recallPlace: avg((s) => s.recallPlace),
          f1Place: avg((s) => s.f1Place),
          f1Spread: Math.max(...ss.map((s) => s.f1Place)) - Math.min(...ss.map((s) => s.f1Place)),
          precisionPlace: avg((s) => s.precisionPlace),
          correct: avg((s) => s.correct),
          wrong: avg((s) => s.wrong),
          posErrMedian: avg((s) => s.posErrMedian),
          durRatioMedian: avg((s) => s.durRatioMedian),
          absorbMean: avg((s) => s.absorbMean),
        }
      }

      const rSweep = (tripSets: Trip[][], label: string, t = 1800) => {
        say()
        say(`### ${label}`)
        say()
        say(
          `| R（許容移動） | 復元件数 | 当たり | 外れ | **限界比** | 再現率（位置込み） | ` +
            `適合率（位置込み） | F1 | 位置誤差 中央 | 滞在時間比 |`,
        )
        say('|---|---|---|---|---|---|---|---|---|---|')
        const rows = RS.map((r) => ({ r, s: meanScore(tripSets, t, r) }))
        for (let i = 0; i < rows.length; i++) {
          const { r, s } = rows[i]!
          const prev = i > 0 ? rows[i - 1]!.s : undefined
          // 限界比 = R を 1 段緩めて増えた復元のうち、当たりが外れの何倍あったか。
          // 1.0 を割ったら「増やすほど外れの方が多い」ということ。
          const dCorrect = prev ? s.correct - prev.correct : Number.NaN
          const dWrong = prev ? s.wrong - prev.wrong : Number.NaN
          const marginal = prev && dWrong > 0 ? dCorrect / dWrong : Number.NaN
          const rLabel = Number.isFinite(r) ? `${r}m` : '∞（無効化）'
          say(
            `| ${rLabel} | ${s.derived.toFixed(0)} | ${s.correct.toFixed(0)} | ${s.wrong.toFixed(0)} | ` +
              `**${Number.isNaN(marginal) ? '-' : marginal.toFixed(2)}** | ` +
              `${pct(s.recallPlace)} | ${pct(s.precisionPlace)} | ` +
              `${(s.f1Place * 100).toFixed(1)} | ` +
              `${meters(s.posErrMedian)} | ${s.durRatioMedian.toFixed(2)} |`,
          )
        }
        return rows
      }

      const thinSets = runs.map((r) => r.trips)
      const rows = rSweep(thinSets, `R の掃引（T = 30 分固定・${SEEDS.length} シード平均）`)

      // 「限界比が 1 を割る手前」が、緩めても損にならない上限。
      let lastGood = rows[0]!.r
      for (let i = 1; i < rows.length; i++) {
        const dC = rows[i]!.s.correct - rows[i - 1]!.s.correct
        const dW = rows[i]!.s.wrong - rows[i - 1]!.s.wrong
        if (dW > 0 && dC / dW < 1) break
        lastGood = rows[i]!.r
      }
      say()
      say(
        `**限界比が 1 を保てる上限は R = ${Number.isFinite(lastGood) ? `${lastGood}m` : '∞'}。**` +
          'ここまでは R を緩めるほど「当たりの増加 ≧ 外れの増加」で、' +
          'これを超えると増える復元の方が外れが多くなる。' +
          'F1 は R を緩めるほど単調に上がるが、それは再現率の増分が適合率の減分を' +
          '上回るだけで、最適値の指標にはならない（距離判定なしが常に勝ってしまう）。',
      )

      // R の結論が T = 30 分でしか成り立たないと困るので、実装の既定でも同じ表を出す。
      rSweep(thinSets, `R の掃引（T = 60 分＝実装の既定・${SEEDS.length} シード平均）`, 3600)

      say()
      say(`### T の掃引（R = 既定の 120m 固定・${SEEDS.length} シード平均）`)
      say()
      say('| T（最短滞在） | 復元件数 | 再現率（位置込み） | 適合率（位置込み） | F1 |')
      say('|---|---|---|---|---|')
      for (const t of TS) {
        const s = meanScore(thinSets, t, 120)
        say(
          `| ${t / 60}分 | ${s.derived.toFixed(0)} | ${pct(s.recallPlace)} | ` +
            `${pct(s.precisionPlace)} | ${(s.f1Place * 100).toFixed(1)} |`,
        )
      }

      rSweep([full.trips], `参考: 間引かない ${EVAL_YEAR} 年（記録が濃いまま・T = 30 分）`)

      say()
      console.log('\n' + lines.join('\n') + '\n')
    },
  )
})
