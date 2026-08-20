import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dataset, PlaybackSettings, TimeWindow } from '../core/types'
import {
  activeVisitAt,
  advance,
  buildTimeMap,
  defaultSpeedFor,
  filterTripsToWindow,
  findGaps,
  rebaseTimes,
} from '../core/playback'
import { computeTripColors } from './colors'

/** 空白とみなす最小の長さ。これ以上あいたら「記録が無い区間」として詰められる */
const GAP_THRESHOLD_SEC = 6 * 3600

const DEFAULT_SETTINGS: PlaybackSettings = {
  speed: 86400,
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
    setSettings((s) => ({ ...s, speed: defaultSpeedFor(bounds.end - bounds.start) }))
  }, [bounds])

  const trips = useMemo(
    () => (dataset ? filterTripsToWindow(dataset.trips, selection) : []),
    [dataset, selection],
  )
  const rel = useMemo(() => rebaseTimes(trips, selection.start), [trips, selection.start])

  const timeMap = useMemo(
    () => buildTimeMap(selection, findGaps(trips, selection, GAP_THRESHOLD_SEC), settings.skipGaps),
    [trips, selection, settings.skipGaps],
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

  const changeWindow = useCallback((w: TimeWindow) => {
    setSelection(w)
    setPos(0)
  }, [])

  return {
    bounds,
    selection,
    changeWindow,
    settings,
    changeSettings,
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
  }
}
