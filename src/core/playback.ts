/**
 * 再生（タイムライン・アニメーション）まわりの純粋関数。
 * DESIGN.md §6.4 の前提（float32 精度・記録ギャップのスキップ表示）を実装する。
 * 副作用なし・純粋関数のみ。
 */
import type { Trip, TimeWindow, Gap, TimeMap, Visit, Seconds } from './types'

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 期間に重なるトリップだけを返す（トリップの [tStart, tEnd] が window と交差するもの） */
export function filterTripsToWindow(trips: Trip[], w: TimeWindow): Trip[] {
  return trips.filter((trip) => trip.tStart <= w.end && trip.tEnd >= w.start)
}

/** 各トリップの times を「window.start からの相対秒」の Float32Array に直す。
 *  戻り値の配列は入力 trips と同じ順序・同じ長さ。
 *  絶対 Unix 秒（~1.79e9）のまま float32 化すると精度が ~107 秒まで落ち、
 *  中央値 240 秒の点間隔が区別できなくなる（DESIGN.md §6.4）。tBase を引いてから
 *  float32 化することで、値を小さく保ち必要な精度を確保する。 */
export function rebaseTimes(trips: Trip[], tBase: number): Float32Array[] {
  return trips.map((trip) => {
    const out = new Float32Array(trip.times.length)
    for (let i = 0; i < trip.times.length; i++) {
      out[i] = trip.times[i] - tBase
    }
    return out
  })
}

/** window 内で、どのトリップにも覆われていない区間のうち minGapSec を超えるものを返す。
 *  トリップは時刻順とは限らないので、内部でソート＆マージしてから隙間を求める。
 *  window の先頭・末尾の空白も含める。 */
export function findGaps(trips: Trip[], w: TimeWindow, minGapSec: number): Gap[] {
  const sorted = [...trips].sort((a, b) => a.tStart - b.tStart)

  // 重なる／隣接するトリップ区間をマージする。
  const merged: Array<{ start: Seconds; end: Seconds }> = []
  for (const trip of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && trip.tStart <= last.end) {
      last.end = Math.max(last.end, trip.tEnd)
    } else {
      merged.push({ start: trip.tStart, end: trip.tEnd })
    }
  }

  const gaps: Gap[] = []
  let cursor = w.start
  for (const iv of merged) {
    const gapEnd = Math.min(iv.start, w.end)
    if (gapEnd - cursor > minGapSec) {
      gaps.push({ start: cursor, end: gapEnd })
    }
    cursor = Math.max(cursor, iv.end)
    if (cursor >= w.end) break
  }
  if (cursor < w.end && w.end - cursor > minGapSec) {
    gaps.push({ start: cursor, end: w.end })
  }

  return gaps
}

/** buildTimeMap が内部で使う、実時刻区間 <-> 圧縮時間区間の対応表の 1 区間。
 *  区間は互いに接し合い、real・compressed どちらの軸でも単調に並ぶ。 */
interface TimeSegment {
  realStart: Seconds
  realEnd: Seconds
  compStart: number
  compEnd: number
}

/** value がどの区間に属するか二分探索する。segments は endOf() について単調増加で、
 *  隙間なく連続している前提。 */
function findSegmentIndex(
  segments: TimeSegment[],
  value: number,
  endOf: (seg: TimeSegment) => number,
): number {
  let lo = 0
  let hi = segments.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (value < endOf(segments[mid])) {
      hi = mid
    } else {
      lo = mid + 1
    }
  }
  return lo
}

const DEFAULT_HOLD_SEC = 2

/** 圧縮時間軸を作る。skip が false なら恒等写像（totalSec = w.end - w.start）。
 *  skip が true なら、各 gap を holdSec 秒（既定 2 秒。実時間の長さではなく、圧縮
 *  タイムライン上で消費する秒数としての holdSec 秒）に縮めた区間写像にする。
 *  gap の中では実時刻が線形に進む。toReal / toCompressed は互いに逆写像であること
 *  （gap 内部を除き誤差 1 秒未満）。範囲外の入力はクランプする。
 *  区間の一覧をあらかじめ作っておくことで、毎フレーム呼ばれる toReal/toCompressed を
 *  O(log n) にしている。 */
export function buildTimeMap(
  w: TimeWindow,
  gaps: Gap[],
  skip: boolean,
  holdSec: number = DEFAULT_HOLD_SEC,
): TimeMap {
  if (!skip) {
    const totalSec = Math.max(0, w.end - w.start)
    return {
      totalSec,
      toReal: (compressed: number) => w.start + clamp(compressed, 0, totalSec),
      toCompressed: (real: Seconds) => clamp(real, w.start, w.end) - w.start,
    }
  }

  // window に収まるように gap をクランプし、開始時刻順に並べる。
  const sortedGaps = gaps
    .map((g) => ({ start: Math.max(g.start, w.start), end: Math.min(g.end, w.end) }))
    .filter((g) => g.end > g.start)
    .sort((a, b) => a.start - b.start)

  const segments: TimeSegment[] = []
  let cursorReal = w.start
  let cursorComp = 0

  for (const gap of sortedGaps) {
    if (gap.start < cursorReal) continue // 重複・逆転した gap は無視する（防御的）

    if (gap.start > cursorReal) {
      const dur = gap.start - cursorReal
      segments.push({ realStart: cursorReal, realEnd: gap.start, compStart: cursorComp, compEnd: cursorComp + dur })
      cursorComp += dur
      cursorReal = gap.start
    }

    segments.push({ realStart: gap.start, realEnd: gap.end, compStart: cursorComp, compEnd: cursorComp + holdSec })
    cursorComp += holdSec
    cursorReal = gap.end
  }

  if (cursorReal < w.end) {
    const dur = w.end - cursorReal
    segments.push({ realStart: cursorReal, realEnd: w.end, compStart: cursorComp, compEnd: cursorComp + dur })
    cursorComp += dur
    cursorReal = w.end
  }

  const totalSec = cursorComp

  if (segments.length === 0) {
    // window の長さが 0（start === end）のときだけここに来る。
    return {
      totalSec: 0,
      toReal: () => w.start,
      toCompressed: () => 0,
    }
  }

  return {
    totalSec,
    toReal: (compressed: number) => {
      const c = clamp(compressed, 0, totalSec)
      const seg = segments[findSegmentIndex(segments, c, (s) => s.compEnd)]
      const span = seg.compEnd - seg.compStart
      const frac = span > 0 ? (c - seg.compStart) / span : 0
      return seg.realStart + frac * (seg.realEnd - seg.realStart)
    },
    toCompressed: (real: Seconds) => {
      const r = clamp(real, w.start, w.end)
      const seg = segments[findSegmentIndex(segments, r, (s) => s.realEnd)]
      const span = seg.realEnd - seg.realStart
      const frac = span > 0 ? (r - seg.realStart) / span : 0
      return seg.compStart + frac * (seg.compEnd - seg.compStart)
    },
  }
}

/** 選べる再生速度（実時間倍率）の候補。 */
const SPEED_CANDIDATES = [60, 600, 3600, 86400, 604800]
/** この秒数の範囲で再生し終えるくらいの速度が「ちょうどいい」とみなす。 */
const TARGET_MIN_SEC = 60
const TARGET_MAX_SEC = 120

/** 期間の長さから既定の再生速度（実時間倍率）を選ぶ。
 *  候補は [60, 600, 3600, 86400, 604800]。
 *  「その期間を実時間でおよそ 60〜120 秒で再生し終える」倍率のうち、候補の中で最も近いものを返す
 *  （ぴったり範囲に収まる候補が無ければ、範囲との距離が最小のものを返す）。 */
export function defaultSpeedFor(windowSec: number): number {
  let best = SPEED_CANDIDATES[0]
  let bestDist = Infinity
  for (const speed of SPEED_CANDIDATES) {
    const playbackSec = windowSec / speed
    const dist =
      playbackSec < TARGET_MIN_SEC
        ? TARGET_MIN_SEC - playbackSec
        : playbackSec > TARGET_MAX_SEC
          ? playbackSec - TARGET_MAX_SEC
          : 0
    if (dist < bestDist) {
      bestDist = dist
      best = speed
    }
  }
  return best
}

/** 与えた時刻に「滞在中」の訪問を返す（start <= t < end のもの。複数あれば最も短いもの＝
 *  より具体的な場所）。visits は呼び出し側で時刻順に並んでいる前提にせず、内部で start 昇順に
 *  ソートしたうえで、t 以前に始まった訪問だけに二分探索で絞り込んでから走査する。 */
export function activeVisitAt(visits: Visit[], t: Seconds): Visit | undefined {
  const sorted = [...visits].sort((a, b) => a.start - b.start)

  // sorted[0..upperBound) が start <= t。start > t の訪問は t の時点でまだ始まっていない。
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid].start <= t) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  const upperBound = lo

  let best: Visit | undefined
  for (let i = 0; i < upperBound; i++) {
    const v = sorted[i]
    if (t < v.end && (best === undefined || v.end - v.start < best.end - best.start)) {
      best = v
    }
  }
  return best
}

/** 再生ヘッドを 1 フレーム進める。
 *  compressed: 現在の圧縮時間、dtRealSec: 実時間の経過秒、speed: 倍率、map: TimeMap、
 *  loop: 末尾で先頭へ戻すか。
 *  戻り値は次の圧縮時間。loop が false なら totalSec でクランプする。 */
export function advance(
  compressed: number,
  dtRealSec: number,
  speed: number,
  map: TimeMap,
  loop: boolean,
): number {
  const next = compressed + dtRealSec * speed

  if (map.totalSec <= 0) return 0

  if (loop) {
    const wrapped = next % map.totalSec
    return wrapped < 0 ? wrapped + map.totalSec : wrapped
  }

  return clamp(next, 0, map.totalSec)
}
