import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dataset, PlaybackSettings, TimeWindow } from '../core/types'
import {
  activeVisitAt,
  advance,
  buildMotionTimeMap,
  buildTimeMap,
  defaultPaceFor,
  defaultSpeedFor,
  filterTripsToWindow,
  findGaps,
  rebaseTimes,
} from '../core/playback'
import { computeTripColors } from './colors'
import { positionAt } from './position'

/** 空白とみなす最小の長さ。これ以上あいたら「記録が無い区間」として詰められる */
const GAP_THRESHOLD_SEC = 6 * 3600

/** 尾の長さのプリセット（PlaybackBar と同じ並び） */
const TRAIL_PRESETS = [
  3600, 21600, 86400, 604800, 2592000, 7776000, 15552000, 31536000, 63072000, 315360000,
]

/**
 * 期間の長さから尾の長さを選ぶ。目安は期間の 1/20。
 * 数年スパンで 1 週間の尾は一瞬で消えてしまうため、期間に追随させる。
 */
export function defaultTrailFor(windowSec: number): number {
  const target = windowSec / 20
  let best = TRAIL_PRESETS[0]!
  for (const p of TRAIL_PRESETS) if (p <= target) best = p
  return best
}

const DEFAULT_SETTINGS: PlaybackSettings = {
  speed: 86400,
  pace: 'time',
  // 残る実線＋先頭の尾。加算合成にすると通った回数の多い道が濃く光る
  trail: 'both',
  trailLengthSec: 6 * 3600,
  skipGaps: true,
  colorBy: 'year',
  lineWidth: 1.5,
  opacity: 0.8,
  additiveBlending: true,
  camera: 'fixed',
}

export function usePlayback(dataset: Dataset | null) {
  const bounds = useMemo<TimeWindow>(
    () => (dataset ? { start: dataset.tMin, end: dataset.tMax } : { start: 0, end: 1 }),
    [dataset],
  )

  const [selection, setSelection] = useState<TimeWindow>(bounds)
  const [settings, setSettings] = useState<PlaybackSettings>(DEFAULT_SETTINGS)
  const [playing, setPlaying] = useState(false)
  /** 圧縮時間軸上の再生位置（秒） */
  const [pos, setPos] = useState(0)

  // データが変わったら期間と再生位置を初期化し、期間の長さに合った速度を選ぶ
  useEffect(() => {
    setSelection(bounds)
    setPos(0)
    setPlaying(false)
    const span = bounds.end - bounds.start
    setSettings((s) => ({
      ...s,
      speed: defaultSpeedFor(span),
      trailLengthSec: defaultTrailFor(span),
    }))
  }, [bounds])

  const trips = useMemo(
    () => (dataset ? filterTripsToWindow(dataset.trips, selection) : []),
    [dataset, selection],
  )
  const rel = useMemo(() => rebaseTimes(trips, selection.start), [trips, selection.start])

  // 'motion' モードの目標オンスクリーン速度。settings には持たせず、trips/selection から
  // 都度算出する派生値にする（ユーザーが直接編集する値ではないため）。
  const paceSpeedMps = useMemo(() => defaultPaceFor(trips, selection), [trips, selection])

  const timeMap = useMemo(
    () =>
      settings.pace === 'motion'
        ? buildMotionTimeMap(selection, trips, paceSpeedMps)
        : buildTimeMap(selection, findGaps(trips, selection, GAP_THRESHOLD_SEC), settings.skipGaps),
    [trips, selection, settings.pace, settings.skipGaps, paceSpeedMps],
  )

  const years = useMemo(() => {
    const ys = dataset?.coverage.map((c) => c.year) ?? []
    return { min: ys.length ? Math.min(...ys) : 2018, max: ys.length ? Math.max(...ys) : 2026 }
  }, [dataset])

  const colors = useMemo(
    () => computeTripColors(trips, settings.colorBy, years.min, years.max),
    [trips, settings.colorBy, years.min, years.max],
  )

  const currentTime = timeMap.toReal(pos)
  const currentRel = currentTime - selection.start
  const progress = timeMap.totalSec > 0 ? pos / timeMap.totalSec : 0

  const cursor = useMemo(() => positionAt(trips, rel, currentRel), [trips, rel, currentRel])

  const activeVisit = useMemo(
    () => (dataset ? activeVisitAt(dataset.visits, currentTime) : undefined),
    [dataset, currentTime],
  )

  /** 表示用のタイムゾーン。記録側のオフセットを使う（海外滞在中は現地時刻になる） */
  const tzOffsetMin = useMemo(() => {
    if (activeVisit) return activeVisit.tzOffsetMin
    const visits = dataset?.visits
    if (!visits || visits.length === 0) return 0
    let best = visits[0]!
    let bestDiff = Math.abs(best.start - currentTime)
    for (const v of visits) {
      const d = Math.abs(v.start - currentTime)
      if (d < bestDiff) {
        best = v
        bestDiff = d
      }
    }
    return best.tzOffsetMin
  }, [activeVisit, dataset, currentTime])

  // 再生ループ
  const raf = useRef(0)
  const last = useRef(0)
  useEffect(() => {
    if (!playing) return
    last.current = performance.now()
    const tick = (now: number) => {
      const dt = (now - last.current) / 1000
      last.current = now
      setPos((p) => advance(p, dt, settings.speed, timeMap, true))
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [playing, settings.speed, timeMap])

  const scrub = useCallback(
    (fraction: number) => setPos(Math.max(0, Math.min(1, fraction)) * timeMap.totalSec),
    [timeMap],
  )

  const changeSettings = useCallback(
    (patch: Partial<PlaybackSettings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  )

  // ペースの切替では speed の意味が変わる（time: 実時間倍率 / motion: 相対倍率 ×0.5〜×4）ので、
  // 単純な changeSettings ではなく専用のリセット込みコールバックにする。していないと、
  // time→motion 切替直後に speed=86400 のまま（一瞬で終わる）、逆方向も speed=1 のまま
  // （期間の長さだけ実時間がかかる）になってしまう。
  const changePace = useCallback(
    (pace: PlaybackSettings['pace']) => {
      setSettings((s) => ({
        ...s,
        pace,
        // motion の既定倍率は 0.5（defaultPaceFor が計算した目安ペースの半分）。
        // 等速の ×1 は多くのデータで体感的に速すぎたため、控えめな側から始める。
        speed: pace === 'motion' ? 0.5 : defaultSpeedFor(selection.end - selection.start),
      }))
    },
    [selection],
  )

  // 期間を変えたら、その長さに合った速度と尾の長さに選び直す。
  // 8 年を見るときと 1 日を見るときで適切な値がまるで違うため。
  const changeWindow = useCallback((w: TimeWindow) => {
    setSelection(w)
    setPos(0)
    const span = Math.max(1, w.end - w.start)
    setSettings((s) => ({
      ...s,
      speed: defaultSpeedFor(span),
      trailLengthSec: defaultTrailFor(span),
    }))
  }, [])

  return {
    bounds,
    selection,
    changeWindow,
    settings,
    changeSettings,
    changePace,
    playing,
    setPlaying,
    pos,
    progress,
    scrub,
    currentTime,
    currentRel,
    tzOffsetMin,
    trips,
    rel,
    colors,
    activeVisit,
    cursor,
  }
}
