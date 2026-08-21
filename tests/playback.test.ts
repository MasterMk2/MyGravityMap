import { describe, it, expect } from 'vitest'
import type { Trip, TimeWindow, Visit } from '../src/core/types'
import { haversineMeters } from '../src/core/geo'
import {
  filterTripsToWindow,
  rebaseTimes,
  findGaps,
  buildTimeMap,
  buildMotionTimeMap,
  defaultPaceFor,
  defaultSpeedFor,
  activeVisitAt,
  advance,
  MOTION_TARGET_DURATION_SEC,
} from '../src/core/playback'

const DAY = 86400

/** テスト用の最小 Trip を作る。座標は合成値（東京近辺, 35.1/139.7 系）で実データではない。 */
function makeTrip(tStart: number, tEnd: number, times?: number[]): Trip {
  const ts = times ?? (tStart === tEnd ? [tStart] : [tStart, tEnd])
  const coords = new Float64Array(ts.length * 2)
  for (let i = 0; i < ts.length; i++) {
    coords[i * 2] = 139.7
    coords[i * 2 + 1] = 35.1
  }
  return {
    coords,
    times: Int32Array.from(ts),
    tStart,
    tEnd,
    mode: 'UNKNOWN',
    isFlight: false,
  }
}

/** 各点に異なる座標を持たせられる Trip。距離ベースのペース（buildMotionTimeMap/
 *  defaultPaceFor）のテスト用 — makeTrip は全点同座標（距離ゼロ）になるため使えない。 */
function makeTripWithCoords(times: number[], lonLat: Array<[number, number]>): Trip {
  const coords = new Float64Array(lonLat.length * 2)
  lonLat.forEach(([lon, lat], i) => {
    coords[i * 2] = lon
    coords[i * 2 + 1] = lat
  })
  return {
    coords,
    times: Int32Array.from(times),
    tStart: times[0]!,
    tEnd: times[times.length - 1]!,
    mode: 'UNKNOWN',
    isFlight: false,
  }
}

/** テスト用の最小 Visit を作る。 */
function makeVisit(start: number, end: number): Visit {
  return {
    start,
    end,
    tzOffsetMin: 540,
    lat: 35.1,
    lon: 139.7,
    semanticType: 'UNKNOWN',
    hierarchyLevel: 0,
    probability: 0.9,
    source: 'google',
    durationReliable: true,
  }
}

describe('filterTripsToWindow', () => {
  it('includes trips that straddle the window edges and excludes trips entirely outside', () => {
    const w: TimeWindow = { start: 1000, end: 2000 }
    const inside = makeTrip(1200, 1800)
    const straddleLeft = makeTrip(500, 1100) // ends inside the window
    const straddleRight = makeTrip(1900, 2500) // starts inside the window
    const outsideBefore = makeTrip(0, 500) // ends before window.start
    const outsideAfter = makeTrip(3000, 4000) // starts after window.end

    const result = filterTripsToWindow(
      [inside, straddleLeft, straddleRight, outsideBefore, outsideAfter],
      w,
    )

    expect(result).toEqual([inside, straddleLeft, straddleRight])
  })
})

describe('rebaseTimes', () => {
  it('produces small values that preserve ordering for a 1-day window', () => {
    const tBase = 1_700_000_000
    const trip = makeTrip(tBase, tBase + 86000, [tBase, tBase + 43200, tBase + 86000])
    const [rebased] = rebaseTimes([trip], tBase)

    expect(Array.from(rebased)).toEqual([0, 43200, 86000])
    for (const v of rebased) {
      expect(v).toBeLessThan(90000)
    }
    // 順序が保たれている（狭義単調増加）
    for (let i = 1; i < rebased.length; i++) {
      expect(rebased[i]).toBeGreaterThan(rebased[i - 1])
    }
  })

  it('regression guard: fround(absolute epoch seconds) breaks strict monotonicity; fround(rebased) does not', () => {
    // Unix 秒の実際の大きさ（~1.7e9）付近では float32 の丸め幅（ULP）が最大 128 秒
    // 程度になる（24bit 仮数部の精度限界）。中央値ギャップ 240 秒はこの丸め幅と
    // 同じ桁なので、記録点が中央値より密な区間（60 秒間隔など、実データでは普通に
    // 起こる）では、絶対 Unix 秒のまま float32 化すると複数の点が同じ値に丸め込まれ、
    // Trip.times が保証するはずの「厳密な単調増加」が壊れる。これは
    // deck.gl の TripsLayer にとって致命的（軌跡が飛ぶ・止まる）。
    // 以下は実際に Math.fround で確認した具体例。
    const base = 1_700_000_000
    const offsets = [0, 60, 120, 180, 240, 300] // 60 秒間隔（中央値 240 秒より密なクラスタを模す）
    const absTimes = offsets.map((o) => base + o)

    const froundedAbs = absTimes.map((t) => Math.fround(t))
    let monotonicAbs = true
    for (let i = 1; i < froundedAbs.length; i++) {
      if (!(froundedAbs[i] > froundedAbs[i - 1])) monotonicAbs = false
    }
    // 絶対時刻のまま float32 化すると、隣接点が同じ値に潰れて単調増加が壊れる
    // （実測: 1700000060 と 1700000000 がどちらも 1700000000 に丸まる）。
    expect(monotonicAbs).toBe(false)
    expect(froundedAbs[0]).toBe(froundedAbs[1])

    const trip = makeTrip(absTimes[0], absTimes[absTimes.length - 1], absTimes)
    const [rebased] = rebaseTimes([trip], base)
    for (let i = 1; i < rebased.length; i++) {
      expect(rebased[i]).toBeGreaterThan(rebased[i - 1])
    }

    // 参考: この大きさでの丸め誤差そのものが中央値ギャップ（240 秒）と同じ桁である
    // ことも確認しておく（誤差が中央値ギャップより十分小さければ、危険性は低い）。
    const quantizationError = Math.abs(Math.fround(base + 240) - (base + 240))
    expect(quantizationError).toBeGreaterThan(0)
    expect(quantizationError).toBeLessThan(240)
  })
})

describe('findGaps', () => {
  it('finds the hole between trips plus leading/trailing gaps, given unsorted input', () => {
    const w: TimeWindow = { start: 0, end: 12 * DAY }
    // わざと時刻順でなく渡す
    const trips = [
      makeTrip(7 * DAY, 8 * DAY),
      makeTrip(2 * DAY, 3 * DAY),
      makeTrip(6 * DAY, 7 * DAY), // trip3 に隣接（間に隙間なし）
    ]

    const gaps = findGaps(trips, w, DAY)

    expect(gaps).toEqual([
      { start: 0, end: 2 * DAY }, // 先頭の空白
      { start: 3 * DAY, end: 6 * DAY }, // トリップ間の 3 日の穴
      { start: 8 * DAY, end: 12 * DAY }, // 末尾の空白
    ])
  })

  it('omits gaps that do not exceed minGapSec', () => {
    const w: TimeWindow = { start: 0, end: 10 * DAY }
    const trips = [makeTrip(0, 5 * DAY), makeTrip(5 * DAY + 100, 10 * DAY)] // 100 秒の隙間のみ
    const gaps = findGaps(trips, w, DAY)
    expect(gaps).toEqual([])
  })

  it('excludes a gap that is exactly minGapSec (spec says "超える" = strictly greater than)', () => {
    const w: TimeWindow = { start: 0, end: 10 * DAY }
    const trips = [makeTrip(0, 5 * DAY), makeTrip(5 * DAY + DAY, 10 * DAY)] // 隙間はちょうど 1 日
    const gaps = findGaps(trips, w, DAY)
    expect(gaps).toEqual([])
  })

  it('returns the whole window as one gap when there are no trips', () => {
    const w: TimeWindow = { start: 0, end: 5 * DAY }
    const gaps = findGaps([], w, DAY)
    expect(gaps).toEqual([{ start: 0, end: 5 * DAY }])
  })
})

describe('buildTimeMap', () => {
  it('is the identity map when skip is false', () => {
    const w: TimeWindow = { start: 1000, end: 1000 + 10 * DAY }
    const map = buildTimeMap(w, [{ start: 1500 * DAY, end: 1600 * DAY }], false)

    expect(map.totalSec).toBe(10 * DAY)
    expect(map.toReal(0)).toBe(w.start)
    expect(map.toReal(map.totalSec)).toBe(w.end)
    expect(map.toCompressed(w.start)).toBe(0)
    expect(map.toCompressed(w.end)).toBe(map.totalSec)

    // 範囲外はクランプされる
    expect(map.toReal(-100)).toBe(w.start)
    expect(map.toReal(map.totalSec + 100)).toBe(w.end)
    expect(map.toCompressed(w.start - 100)).toBe(0)
    expect(map.toCompressed(w.end + 100)).toBe(map.totalSec)

    for (const sample of [0, 1234, 5 * DAY, map.totalSec]) {
      expect(map.toReal(sample)).toBe(w.start + sample)
    }
  })

  it('compresses gaps to holdSec when skip is true, and stays invertible outside gaps', () => {
    const w: TimeWindow = { start: 0, end: 10 * DAY }
    const gap = { start: 2 * DAY, end: 5 * DAY } // 3 日の穴
    const holdSec = 2
    const map = buildTimeMap(w, [gap], true, holdSec)

    // 3 日の穴が holdSec 秒に縮む分、totalSec は元の期間よりずっと小さい
    expect(map.totalSec).toBeLessThan(w.end - w.start)
    expect(map.totalSec).toBeCloseTo((w.end - w.start) - (gap.end - gap.start) + holdSec, 6)

    // gap の外側にあるサンプル点は、圧縮しても実質恒等写像（誤差 1 秒未満で往復できる）
    const outsideSamples = [0, DAY, 2 * DAY, 7 * DAY, 9 * DAY, 10 * DAY]
    for (const real of outsideSamples) {
      const roundTripped = map.toReal(map.toCompressed(real))
      expect(Math.abs(roundTripped - real)).toBeLessThan(1)
    }

    // gap の直前・直後で圧縮タイムラインが連続している
    const compAtGapStart = map.toCompressed(gap.start)
    const compAtGapEnd = map.toCompressed(gap.end)
    expect(compAtGapEnd - compAtGapStart).toBeCloseTo(holdSec, 6)

    // gap の内部でも、圧縮時間 -> 実時刻 -> 圧縮時間 の往復は線形写像として一致する
    // （実装上は精度低下があり得るので、gap 内部はこのテストでは緩めに扱う）
    const compMidGap = compAtGapStart + holdSec / 2
    const realMidGap = map.toReal(compMidGap)
    expect(realMidGap).toBeGreaterThanOrEqual(gap.start)
    expect(realMidGap).toBeLessThanOrEqual(gap.end)
    expect(map.toCompressed(realMidGap)).toBeCloseTo(compMidGap, 1)
  })

  it('clamps out-of-range compressed/real inputs when skip is true', () => {
    const w: TimeWindow = { start: 0, end: 10 * DAY }
    const map = buildTimeMap(w, [{ start: 2 * DAY, end: 5 * DAY }], true, 2)

    expect(map.toReal(-100)).toBe(w.start)
    expect(map.toReal(map.totalSec + 100)).toBe(w.end)
    expect(map.toCompressed(w.start - 100)).toBe(0)
    expect(map.toCompressed(w.end + 100)).toBe(map.totalSec)
  })
})

describe('defaultPaceFor', () => {
  it('targets ~90s playback for the total GPS distance in the window', () => {
    const w: TimeWindow = { start: 0, end: 100 }
    const trip = makeTripWithCoords(
      [0, 100],
      [
        [139.7, 35.1],
        [139.71, 35.11],
      ],
    )
    const dist = haversineMeters(35.1, 139.7, 35.11, 139.71)

    const pace = defaultPaceFor([trip], w)
    expect(pace).toBeCloseTo(dist / MOTION_TARGET_DURATION_SEC, 6)
  })

  it('clips distance to the window rather than counting the whole trip', () => {
    const w: TimeWindow = { start: 0, end: 50 } // trip の前半だけが window に入る
    const trip = makeTripWithCoords(
      [0, 100],
      [
        [139.7, 35.1],
        [139.71, 35.11],
      ],
    )
    const fullDist = haversineMeters(35.1, 139.7, 35.11, 139.71)

    const pace = defaultPaceFor([trip], w)
    // clipTripSegment は時間比で距離を按分するので、window の半分なら距離も半分
    expect(pace).toBeCloseTo(fullDist / 2 / MOTION_TARGET_DURATION_SEC, 6)
  })
})

describe('buildMotionTimeMap', () => {
  it('paces a single segment by distance / targetSpeedMps when under the cap', () => {
    const w: TimeWindow = { start: 0, end: 100 }
    const trip = makeTripWithCoords(
      [0, 100],
      [
        [139.7, 35.1],
        [139.71, 35.11],
      ],
    )
    const dist = haversineMeters(35.1, 139.7, 35.11, 139.71)
    const targetSpeedMps = dist / 3 // 3秒で走破するペース（上限 90*0.08=7.2秒 未満）

    // trip が window ぴったりを覆っているので空白は無く、hold は発生しない
    const map = buildMotionTimeMap(w, [trip], targetSpeedMps)
    expect(map.totalSec).toBeCloseTo(3, 6)
  })

  it('caps a single huge jump so it cannot dominate playback', () => {
    const w: TimeWindow = { start: 0, end: 100 }
    // 東京とニューヨーク相当の遠く離れた2点を1区間に押し込む（GPS 記録ギャップの想定）
    const trip = makeTripWithCoords(
      [0, 100],
      [
        [139.7, 35.1],
        [-74.0, 40.7],
      ],
    )
    const dist = haversineMeters(35.1, 139.7, 40.7, -74.0)
    const targetSpeedMps = dist / 1000 // 素直に計算すると1000秒かかる距離

    const map = buildMotionTimeMap(w, [trip], targetSpeedMps)
    // 上限（目標秒数 90 の 8% = 7.2 秒）に張り付く。1000 秒には全くならない
    expect(map.totalSec).toBeCloseTo(90 * 0.08, 6)
  })

  it('holds through gaps instead of freezing, with a bounded per-gap duration', () => {
    const w: TimeWindow = { start: 0, end: 10 * DAY }
    const trip = makeTrip(3 * DAY, 4 * DAY) // 座標固定（距離ゼロ）。前後に空白が2件できる
    const map = buildMotionTimeMap(w, [trip], 1)

    // 空白2件 × holdSec。budget(0.25*90=22.5)/2件 は上限 1.0 秒でクランプされるので
    // 実際の hold は 1件あたり 1.0 秒 = 合計 2.0 秒（trip 内部は距離ゼロで 0 秒）
    expect(map.totalSec).toBeCloseTo(2, 6)
  })

  it('does not crash and holds the whole window when there are no trips', () => {
    const w: TimeWindow = { start: 0, end: 10 * DAY }
    const map = buildMotionTimeMap(w, [], 1)
    expect(map.totalSec).toBeCloseTo(1, 6) // 空白1件のみ、holdSec は上限 1.0 秒でクランプ
    expect(map.toReal(0)).toBe(w.start)
    expect(map.toReal(map.totalSec)).toBe(w.end)
  })

  it('handles a single-point trip without emitting any distance segment', () => {
    const w: TimeWindow = { start: 0, end: 10 * DAY }
    const trip = makeTrip(5 * DAY, 5 * DAY, [5 * DAY]) // 1点のみ
    const map = buildMotionTimeMap(w, [trip], 1)
    // トリップ自体は区間を生まず、前後の空白2件分の hold のみ
    expect(map.totalSec).toBeCloseTo(2, 6)
  })
})

describe('defaultSpeedFor', () => {
  it('returns a sane multiplier for a 1-day window', () => {
    // 86400 / 600 = 144 秒、86400 / 3600 = 24 秒。前者のほうが目標の 60〜120 秒に近い
    // （距離 24 秒 vs 36 秒）ので 600 を返す。仕様コメントの例示「3600 前後」とは
    // 一致しないが、それはあくまで概算の例示であり、本文の定義（60〜120 秒に最も
    // 近い候補）を厳密に計算するとこの結果になる。
    expect(defaultSpeedFor(DAY)).toBe(600)
  })

  it('returns a sane multiplier for a 1-year window', () => {
    // 31536000 / 604800 ≈ 52 秒（60〜120 秒への距離が候補中最小）。
    expect(defaultSpeedFor(365 * DAY)).toBe(604800)
  })

  it('returns the largest candidate for an 8-year window', () => {
    // どの候補でも 120 秒には収まらないほど長い期間なので、最も再生時間が
    // 短くなる最大候補 (604800 = 1 週間/秒) が選ばれる。
    expect(defaultSpeedFor(8 * 365 * DAY)).toBe(604800)
  })
})

describe('activeVisitAt', () => {
  it('picks the shorter of two overlapping visits', () => {
    const coarse = makeVisit(0, 100000) // 長い滞在（例: 大きな地域）
    const specific = makeVisit(40000, 50000) // 短い滞在（例: 具体的な店）
    const result = activeVisitAt([coarse, specific], 45000)
    expect(result).toBe(specific)
  })

  it('returns undefined outside any visit', () => {
    const v = makeVisit(1000, 2000)
    expect(activeVisitAt([v], 500)).toBeUndefined()
    expect(activeVisitAt([v], 2000)).toBeUndefined() // end は含まない
  })

  it('treats start as inclusive', () => {
    const v = makeVisit(1000, 2000)
    expect(activeVisitAt([v], 1000)).toBe(v)
  })

  it('works regardless of input order', () => {
    const a = makeVisit(0, 1000)
    const b = makeVisit(2000, 3000)
    const c = makeVisit(4000, 5000)
    expect(activeVisitAt([c, a, b], 2500)).toBe(b)
  })
})

describe('advance', () => {
  it('clamps at totalSec when loop is false', () => {
    const map = buildTimeMap({ start: 0, end: 100 }, [], false)
    const next = advance(90, 100, 1, map, false)
    expect(next).toBe(100)
  })

  it('does not go below 0 when loop is false', () => {
    const map = buildTimeMap({ start: 0, end: 100 }, [], false)
    const next = advance(10, -100, 1, map, false)
    expect(next).toBe(0)
  })

  it('wraps around to the start when loop is true', () => {
    const map = buildTimeMap({ start: 0, end: 100 }, [], false)
    const next = advance(90, 30, 1, map, true) // 90 + 30 = 120 -> wraps to 20
    expect(next).toBe(20)
  })

  it('advances normally within range', () => {
    const map = buildTimeMap({ start: 0, end: 100 }, [], false)
    const next = advance(10, 5, 2, map, false) // 10 + 5*2 = 20
    expect(next).toBe(20)
  })
})
