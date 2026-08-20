import { useState } from 'react'
import type { ChangeEvent, JSX } from 'react'
import type { PlaybackSettings, Seconds, TimeWindow, YearCoverage } from '../core/types'
import './PlaybackBar.css'

export interface PlaybackBarProps {
  /** データ全体の範囲(絶対 Unix 秒) */
  bounds: TimeWindow
  /** 選択中の期間 */
  window: TimeWindow
  onWindowChange: (w: TimeWindow) => void

  playing: boolean
  onPlayingChange: (p: boolean) => void

  /** 現在の再生位置(絶対 Unix 秒) */
  currentTime: number
  /** スクラブ操作。0..1 の割合で渡す */
  onScrub: (fraction: number) => void
  /** 再生位置の 0..1 の割合(圧縮時間軸上の位置。currentTime から計算してはいけない) */
  progress: number

  settings: PlaybackSettings
  onSettingsChange: (patch: Partial<PlaybackSettings>) => void

  /** 年ごとの記録の濃さ。期間スライダーに品質バンドとして重ねる */
  coverage: YearCoverage[]
  /** 表示に使う UTC オフセット(分)。記録側のタイムゾーンで時刻を出すため */
  tzOffsetMin: number
}

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土']

const SPEED_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 60, label: '1分/秒' },
  { value: 600, label: '10分/秒' },
  { value: 3600, label: '1時間/秒' },
  { value: 86400, label: '1日/秒' },
  { value: 604800, label: '1週/秒' },
]

const TRAIL_OPTIONS: Array<{ value: PlaybackSettings['trail']; label: string }> = [
  { value: 'gradient', label: 'グラデーション' },
  { value: 'solid', label: '実線' },
  { value: 'both', label: '両方' },
]

const TRAIL_LENGTH_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 3600, label: '1時間' },
  { value: 21600, label: '6時間' },
  { value: 86400, label: '1日' },
  { value: 604800, label: '1週間' },
]

const COLOR_BY_OPTIONS: Array<{ value: PlaybackSettings['colorBy']; label: string }> = [
  { value: 'single', label: '単色' },
  { value: 'mode', label: '交通手段' },
  { value: 'year', label: '年' },
  { value: 'speed', label: '速度' },
  { value: 'hour', label: '時間帯' },
]

type PresetKind = 'day' | 'week' | 'month' | 'year' | 'all'

const PRESETS: Array<{ kind: PresetKind; label: string }> = [
  { kind: 'day', label: 'この1日' },
  { kind: 'week', label: '1週間' },
  { kind: 'month', label: '1か月' },
  { kind: 'year', label: '1年' },
  { kind: 'all', label: '全期間' },
]

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** マシンのローカル時刻ではなく、記録側の tzOffsetMin を反映した「見かけ上の」Date を作る。
 *  取り出す際は必ず UTC 系ゲッターを使うこと。 */
function toLocalDate(t: Seconds, tzOffsetMin: number): Date {
  return new Date((t + tzOffsetMin * 60) * 1000)
}

function formatClock(t: Seconds, tzOffsetMin: number): string {
  const d = toLocalDate(t, tzOffsetMin)
  const y = d.getUTCFullYear()
  const mo = pad2(d.getUTCMonth() + 1)
  const da = pad2(d.getUTCDate())
  const wd = WEEKDAY_JA[d.getUTCDay()]
  const hh = pad2(d.getUTCHours())
  const mm = pad2(d.getUTCMinutes())
  return `${y}-${mo}-${da} (${wd}) ${hh}:${mm}`
}

function formatYmd(t: Seconds, tzOffsetMin: number): string {
  const d = toLocalDate(t, tzOffsetMin)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** 記録側の暦で t を操作し、絶対 Unix 秒に戻す(プリセットの「1か月前」等に使う) */
function shiftLocal(t: Seconds, tzOffsetMin: number, mutate: (d: Date) => void): Seconds {
  const d = toLocalDate(t, tzOffsetMin)
  mutate(d)
  return Math.round(d.getTime() / 1000) - tzOffsetMin * 60
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** 指定年(記録側の暦)の [開始, 終了) を絶対 Unix 秒で返す */
function yearRangeAbs(year: number, tzOffsetMin: number): [Seconds, Seconds] {
  const start = Math.round(Date.UTC(year, 0, 1) / 1000) - tzOffsetMin * 60
  const end = Math.round(Date.UTC(year + 1, 0, 1) / 1000) - tzOffsetMin * 60
  return [start, end]
}

export function PlaybackBar(props: PlaybackBarProps): JSX.Element {
  const {
    bounds,
    window: sel,
    onWindowChange,
    playing,
    onPlayingChange,
    currentTime,
    onScrub,
    progress,
    settings,
    onSettingsChange,
    coverage,
    tzOffsetMin,
  } = props

  // 期間スライダーの二つのつまみが重なったときにドラッグ対象を手前に出す
  const [frontThumb, setFrontThumb] = useState<'start' | 'end'>('end')

  const span = Math.max(1, bounds.end - bounds.start)
  // 年単位の範囲を秒刻みで操作すると矢印キーが実質効かないため、範囲に応じた粗さにする
  const periodStep = Math.max(3600, Math.round(span / 2000))
  // 二つのつまみが完全に重なって片方を選べなくなるのを防ぐ最小間隔
  const minGap = Math.max(3600, Math.round(span * 0.005))

  function pct(t: Seconds): number {
    return ((clampNum(t, bounds.start, bounds.end) - bounds.start) / span) * 100
  }

  function handleStartChange(e: ChangeEvent<HTMLInputElement>) {
    const raw = Number(e.target.value)
    const nextStart = clampNum(raw, bounds.start, sel.end - minGap)
    onWindowChange({ start: nextStart, end: sel.end })
  }

  function handleEndChange(e: ChangeEvent<HTMLInputElement>) {
    const raw = Number(e.target.value)
    const nextEnd = clampNum(raw, sel.start + minGap, bounds.end)
    onWindowChange({ start: sel.start, end: nextEnd })
  }

  function handleScrubChange(e: ChangeEvent<HTMLInputElement>) {
    onScrub(clampNum(Number(e.target.value), 0, 1))
  }

  function applyPreset(kind: PresetKind) {
    if (kind === 'all') {
      onWindowChange({ start: bounds.start, end: bounds.end })
      return
    }
    // 「この1日」等は bounds.end ではなく、選択中の期間の終端から遡る
    const end = sel.end
    let start: Seconds
    if (kind === 'day') {
      start = shiftLocal(end, tzOffsetMin, (d) => d.setUTCDate(d.getUTCDate() - 1))
    } else if (kind === 'week') {
      start = shiftLocal(end, tzOffsetMin, (d) => d.setUTCDate(d.getUTCDate() - 7))
    } else if (kind === 'month') {
      start = shiftLocal(end, tzOffsetMin, (d) => d.setUTCMonth(d.getUTCMonth() - 1))
    } else {
      start = shiftLocal(end, tzOffsetMin, (d) => d.setUTCFullYear(d.getUTCFullYear() - 1))
    }
    onWindowChange({ start: clampNum(start, bounds.start, end - minGap), end })
  }

  const clockText = formatClock(currentTime, tzOffsetMin)

  return (
    <div className="playbackbar">
      <div className="playbackbar__row playbackbar__row--main">
        <div className="playbackbar__clock">{clockText}</div>

        <div className="playbackbar__transport">
          <button
            type="button"
            className="playbackbar__iconBtn"
            aria-label="先頭に戻す"
            onClick={() => onScrub(0)}
          >
            ⏮
          </button>
          <button
            type="button"
            className="playbackbar__iconBtn"
            aria-label={playing ? '一時停止' : '再生'}
            aria-pressed={playing}
            onClick={() => onPlayingChange(!playing)}
          >
            {playing ? '⏸' : '▶'}
          </button>
        </div>

        <div className="playbackbar__scrub">
          <input
            type="range"
            className="playbackbar__scrubInput"
            min={0}
            max={1}
            step={0.0001}
            value={progress}
            onChange={handleScrubChange}
            aria-label="再生位置"
            aria-valuetext={clockText}
          />
        </div>

        <div className="playbackbar__group">
          <span className="playbackbar__label">速度</span>
          <div className="segmented" role="group" aria-label="再生速度">
            {SPEED_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={settings.speed === o.value ? 'is-active' : ''}
                aria-pressed={settings.speed === o.value}
                onClick={() => onSettingsChange({ speed: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="playbackbar__row playbackbar__row--settings">
        <div className="playbackbar__group">
          <span className="playbackbar__label">移動痕</span>
          <div className="segmented" role="group" aria-label="移動痕の表現">
            {TRAIL_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={settings.trail === o.value ? 'is-active' : ''}
                aria-pressed={settings.trail === o.value}
                onClick={() => onSettingsChange({ trail: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="playbackbar__group">
          <span className="playbackbar__label">尾の長さ</span>
          <div className="segmented" role="group" aria-label="尾の長さ">
            {TRAIL_LENGTH_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                disabled={settings.trail === 'solid'}
                className={settings.trailLengthSec === o.value ? 'is-active' : ''}
                aria-pressed={settings.trailLengthSec === o.value}
                onClick={() => onSettingsChange({ trailLengthSec: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="playbackbar__group">
          <span className="playbackbar__label">色分け</span>
          <div className="segmented" role="group" aria-label="色分け">
            {COLOR_BY_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={settings.colorBy === o.value ? 'is-active' : ''}
                aria-pressed={settings.colorBy === o.value}
                onClick={() => onSettingsChange({ colorBy: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="playbackbar__group playbackbar__toggleGroup">
          <button
            type="button"
            role="switch"
            aria-checked={settings.skipGaps}
            className={`playbackbar__toggle${settings.skipGaps ? ' is-active' : ''}`}
            onClick={() => onSettingsChange({ skipGaps: !settings.skipGaps })}
          >
            空白スキップ
          </button>
          <span className="playbackbar__hint">記録の無い期間を飛ばす</span>
        </div>
      </div>

      <div className="playbackbar__row playbackbar__row--period">
        <div className="playbackbar__period">
          <div className="playbackbar__periodHead">
            <span className="playbackbar__periodDate">{formatYmd(sel.start, tzOffsetMin)}</span>
            <span className="playbackbar__periodLegend">濃いほど記録が多い</span>
            <span className="playbackbar__periodDate">{formatYmd(sel.end, tzOffsetMin)}</span>
          </div>

          <div className="rangeSlider">
            <div className="rangeSlider__coverage" aria-hidden="true">
              {coverage.map((c) => {
                const [yStart, yEnd] = yearRangeAbs(c.year, tzOffsetMin)
                const left = pct(yStart)
                const width = Math.max(0, pct(yEnd) - left)
                if (width <= 0) return null
                const density = clampNum(c.coverageHoursPerDay / 24, 0, 1)
                const note = c.hasGoogleVisits ? '' : '・訪問データなし'
                return (
                  <div
                    key={c.year}
                    className={
                      'rangeSlider__band' + (c.hasGoogleVisits ? '' : ' rangeSlider__band--warn')
                    }
                    style={{ left: `${left}%`, width: `${width}%`, opacity: 0.12 + density * 0.78 }}
                    title={`${c.year}年: 記録 ${c.coverageHoursPerDay.toFixed(1)} 時間/日${note}`}
                  />
                )
              })}
            </div>

            <div
              className="rangeSlider__selection"
              style={{
                left: `${pct(sel.start)}%`,
                width: `${Math.max(0, pct(sel.end) - pct(sel.start))}%`,
              }}
            />

            <input
              type="range"
              className="rangeSlider__input"
              style={{ zIndex: frontThumb === 'start' ? 3 : 2 }}
              min={bounds.start}
              max={bounds.end}
              step={periodStep}
              value={sel.start}
              onPointerDown={() => setFrontThumb('start')}
              onChange={handleStartChange}
              aria-label="期間の開始"
              aria-valuetext={formatYmd(sel.start, tzOffsetMin)}
            />
            <input
              type="range"
              className="rangeSlider__input"
              style={{ zIndex: frontThumb === 'end' ? 3 : 2 }}
              min={bounds.start}
              max={bounds.end}
              step={periodStep}
              value={sel.end}
              onPointerDown={() => setFrontThumb('end')}
              onChange={handleEndChange}
              aria-label="期間の終了"
              aria-valuetext={formatYmd(sel.end, tzOffsetMin)}
            />
          </div>
        </div>

        <div className="playbackbar__presets" role="group" aria-label="期間プリセット">
          {PRESETS.map((p) => (
            <button key={p.kind} type="button" onClick={() => applyPreset(p.kind)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
