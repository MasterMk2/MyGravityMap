/**
 * カレンダービュー（DESIGN.md §5 #5）。GitHub の草のような「年 × 日」の升目で、
 * 日ごとの移動距離・記録時間・訪問数を色の濃さで見せる。空白期間（記録の無い日）も一目で分かる。
 *
 * - 暦日は記録側のタイムゾーン（core/stats の dailySummary）。
 * - 日を押すとその日を再生期間にする（onSelectWindow）。Shift で範囲。
 * - 日ごとの集計はデータセットにつき 1 回だけ。升目（約 3,000 個）は年ごとに memo して、
 *   親が再生中に何度描き直しても、期間・指標・カーソルが変わらない年は描き直さない。
 * - Tab で 3,000 個を渡らせないよう、フォーカスは年ごとに 1 つ。年の中は矢印キーで動く。
 */
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import type { Dataset, TimeWindow } from '../core/types'
import { createTzLookup } from '../core/timezone'
import { localDayKey } from '../core/geo'
import {
  WEEKDAY_LABELS,
  dailySummary,
  levelOf,
  localDayWindow,
  quantileBreaks,
  weekdayOfKey,
  yearGrid,
  type DayStat,
  type YearGrid,
} from '../core/stats'
import './CalendarView.css'

type Metric = 'km' | 'hours' | 'visits'

const METRICS: { id: Metric; label: string }[] = [
  { id: 'km', label: '移動距離' },
  { id: 'hours', label: '記録時間' },
  { id: 'visits', label: '訪問' },
]

const METRIC_NOTES: Record<Metric, string> = {
  km: '移動距離は、その日の軌跡の点と点の間の直線距離の合計です（飛行機の補間区間を含む）。',
  hours:
    '記録時間は、その日に軌跡が何時間ぶん残っているか（点の間が 30 分以内の区間の合計・飛行の補間区間は除く）です。年ごとの記録の濃さの違いがそのまま見えます。',
  visits:
    '訪問は、その日に始まった滞在の数です。2024 年秋より前は Google の訪問データが無く、軌跡から復元した粗い滞在を数えています。',
}

const nf0 = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 })

function metricValue(d: DayStat, m: Metric): number {
  return m === 'km' ? d.km : m === 'hours' ? d.recordedSec / 3600 : d.visits
}

function fmtKm(km: number): string {
  return km >= 100 ? nf0.format(km) : nf1.format(km)
}

function fmtMetric(v: number, m: Metric): string {
  if (m === 'km') return `${fmtKm(v)} km`
  if (m === 'hours') return `${nf1.format(v)} 時間`
  return `${nf0.format(v)} 件`
}

function dayLabel(key: string): string {
  return `${key}（${WEEKDAY_LABELS[weekdayOfKey(key)]}）`
}

/** 升目のツールチップと、キーボード操作時の読み上げに使う 1 日の説明 */
function describeDay(key: string, d: DayStat | undefined, sep: string): string {
  if (!d) return `${dayLabel(key)}${sep}記録なし`
  const flight = d.flightKm >= 0.05 ? `（うち飛行 ${fmtKm(d.flightKm)} km）` : ''
  return [
    dayLabel(key),
    `移動 ${fmtKm(d.km)} km${flight}`,
    `記録 ${nf1.format(d.recordedSec / 3600)} 時間 · 訪問 ${nf0.format(d.visits)} 件`,
  ].join(sep)
}

// 升目の寸法（SVG 座標）。54 列（最大）で 271 になり、内容幅 ≒ 290px にそのまま収まる
const CELL = 4
const GAP = 1
const PITCH = CELL + GAP
const PAD = 1.5
const TOP = 9
const MAX_COLS = 54
const SVG_W = PAD * 2 + MAX_COLS * PITCH - GAP
const SVG_H = PAD * 2 + TOP + 7 * PITCH - GAP

interface YearBlockProps {
  grid: YearGrid
  daily: Map<string, DayStat>
  metric: Metric
  breaks: number[]
  /** データ全体の最初・最後の日。範囲外の升目は描かない（未来の日を「記録なし」と見せない） */
  firstKey: string
  lastKey: string
  /** 選択中の期間に掛かる最初・最後の日。全期間を選んでいるときは null（全部を囲っても意味が無い） */
  selFrom: string | null
  selTo: string | null
  /** キーボードのカーソル。この年に無ければ null（他の年を描き直さないため） */
  cursor: string | null
  onPick: (key: string, extend: boolean) => void
  onCursor: (key: string) => void
  onSelectYear: (year: number) => void
}

const YearBlock = memo(function YearBlock(p: YearBlockProps): JSX.Element {
  const { grid, daily, metric, breaks, firstKey, lastKey, selFrom, selTo, cursor } = p
  const jan1 = `${grid.year}-01-01`
  const dec31 = `${grid.year}-12-31`
  const lo = firstKey > jan1 ? firstKey : jan1
  const hi = lastKey < dec31 ? lastKey : dec31
  const metricLabel = METRICS.find((m) => m.id === metric)!.label

  const halos: JSX.Element[] = []
  const cells: JSX.Element[] = []
  let recordedDays = 0
  let total = 0
  let best: { key: string; v: number } | null = null
  let loIdx = -1
  let hiIdx = -1
  let cursorXY: [number, number] | null = null

  for (let i = 0; i < grid.cells.length; i++) {
    const c = grid.cells[i]!
    if (c.key < lo || c.key > hi) continue
    if (loIdx < 0) loIdx = i
    hiIdx = i
    const x = PAD + c.col * PITCH
    const y = PAD + TOP + c.row * PITCH
    if (c.key === cursor) cursorXY = [x, y]
    // 選択中の日は 1px 外側まで白く敷く。隣り合う日の敷物が隙間を埋めて、範囲がひと塊に見える
    if (selFrom !== null && selTo !== null && c.key >= selFrom && c.key <= selTo) {
      halos.push(<rect key={c.key} className="cal-halo" x={x - GAP} y={y - GAP} width={CELL + GAP * 2} height={CELL + GAP * 2} />)
    }
    const d = daily.get(c.key)
    let cls = 'cal-cell is-empty'
    if (d) {
      const v = metricValue(d, metric)
      cls = `cal-cell l${levelOf(v, breaks)}`
      recordedDays += 1
      total += v
      if (!best || v > best.v) best = { key: c.key, v }
    }
    cells.push(
      <rect key={c.key} data-day={c.key} className={cls} x={x} y={y} width={CELL} height={CELL} rx={0.8}>
        <title>{describeDay(c.key, d, '\n')}</title>
      </rect>,
    )
  }

  const summary =
    metric === 'hours'
      ? `記録 ${nf0.format(recordedDays)} 日 · 平均 ${nf1.format(recordedDays > 0 ? total / recordedDays : 0)} 時間/日`
      : `記録 ${nf0.format(recordedDays)} 日 · ${fmtMetric(total, metric)}`
  const aria = `${grid.year} 年のカレンダー（${metricLabel}）。記録のある日 ${recordedDays} 日${
    best && best.v > 0 ? `。いちばん多い日は ${dayLabel(best.key)}、${fmtMetric(best.v, metric)}` : ''
  }`

  const move = (delta: number) => {
    if (loIdx < 0) return
    const cur = cursor ? grid.cells.findIndex((c) => c.key === cursor) : -1
    const base = cur >= 0 ? cur : hiIdx
    const next = Math.min(hiIdx, Math.max(loIdx, base + (cur >= 0 ? delta : 0)))
    p.onCursor(grid.cells[next]!.key)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowUp':
        move(-1)
        break
      case 'ArrowDown':
        move(1)
        break
      case 'ArrowLeft':
        move(-7)
        break
      case 'ArrowRight':
        move(7)
        break
      case 'Enter':
      case ' ':
        if (cursor) p.onPick(cursor, e.shiftKey)
        break
      default:
        return
    }
    e.preventDefault()
  }

  const onClick = (e: MouseEvent<SVGSVGElement>) => {
    const key = (e.target as Element).getAttribute('data-day')
    if (key) p.onPick(key, e.shiftKey)
  }

  return (
    <div className="cal-year">
      <div className="cal-year__head">
        <button className="cal-year__btn" onClick={() => p.onSelectYear(grid.year)} title={`${grid.year} 年全体を選択`}>
          {grid.year}
        </button>
        <span className="cal-year__sum">{summary}</span>
      </div>
      <div
        className="cal-year__grid"
        tabIndex={0}
        role="group"
        aria-label={`${grid.year} 年。矢印キーで日を移動、Enter で選択、Shift+Enter で範囲選択`}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (!cursor) move(0)
        }}
      >
        <svg
          className="cal-svg"
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          role="img"
          aria-label={aria}
          onClick={onClick}
          // Shift+クリックで文字列の範囲選択が始まらないように
          onMouseDown={(e) => {
            if (e.shiftKey) e.preventDefault()
          }}
        >
          <g aria-hidden="true">
            {grid.monthCols.map((col, m) => (
              <text key={m} className="cal-month" x={PAD + col * PITCH} y={PAD + TOP - 2.5}>
                {m + 1}
              </text>
            ))}
          </g>
          <g>{halos}</g>
          <g>{cells}</g>
          {cursorXY && (
            <rect
              className="cal-cursor"
              x={cursorXY[0] - 1.5}
              y={cursorXY[1] - 1.5}
              width={CELL + 3}
              height={CELL + 3}
              rx={1.2}
            />
          )}
        </svg>
      </div>
    </div>
  )
})

export function CalendarView(props: {
  dataset: Dataset
  selection: TimeWindow
  onSelectWindow: (w: TimeWindow) => void
}): JSX.Element {
  const { dataset, selection, onSelectWindow } = props
  const [metric, setMetric] = useState<Metric>('km')
  const [cursor, setCursor] = useState<string | null>(null)

  // 親から毎回新しい関数が渡されても升目の memo が崩れないよう、最新の関数を ref 経由で呼ぶ
  const onSelectRef = useRef(onSelectWindow)
  useLayoutEffect(() => {
    onSelectRef.current = onSelectWindow
  })
  /** Shift で範囲を選ぶときの起点（描画には使わないので state にしない） */
  const anchorRef = useRef<string | null>(null)

  const tzOf = useMemo(() => createTzLookup(dataset.tzChanges), [dataset.tzChanges])
  const daily = useMemo(() => dailySummary(dataset), [dataset])

  const keys = useMemo(() => [...daily.keys()], [daily])
  const firstKey = keys[0] ?? ''
  const lastKey = keys[keys.length - 1] ?? ''

  const grids = useMemo(() => {
    if (!firstKey) return []
    const out: YearGrid[] = []
    // 新しい年を上に
    for (let y = Number(lastKey.slice(0, 4)); y >= Number(firstKey.slice(0, 4)); y--) out.push(yearGrid(y))
    return out
  }, [firstKey, lastKey])

  const breaks = useMemo(() => {
    const values: number[] = []
    for (const d of daily.values()) values.push(metricValue(d, metric))
    return quantileBreaks(values)
  }, [daily, metric])

  // 暦日の範囲 → 絶対時刻の期間。その日のうちに TZ が変わる日（海外へ飛んだ日）も、
  // カレンダーがその日に数えた記録がすべて期間に入るように localDayWindow を使う
  const tzChanges = dataset.tzChanges
  const daysWindow = useCallback(
    (from: string, to: string): TimeWindow => ({
      start: localDayWindow(from, tzChanges).start,
      end: localDayWindow(to, tzChanges).end,
    }),
    [tzChanges],
  )

  const pick = useCallback(
    (key: string, extend: boolean) => {
      const anchor = anchorRef.current
      let from = key
      let to = key
      if (extend && anchor) {
        from = anchor < key ? anchor : key
        to = anchor < key ? key : anchor
      } else {
        anchorRef.current = key
      }
      onSelectRef.current(daysWindow(from, to))
      setCursor(key)
    },
    [daysWindow],
  )

  const selectYear = useCallback(
    (year: number) => {
      anchorRef.current = null
      onSelectRef.current(daysWindow(`${year}-01-01`, `${year}-12-31`))
    },
    [daysWindow],
  )

  // 選択中の期間を暦日の範囲に直す。期間の終わりは排他的に扱う（localDayWindow の [開始, 終了) と揃える）
  const endIncl = Math.max(selection.start, selection.end - 1)
  const selFromKey = localDayKey(selection.start, tzOf(selection.start))
  const selToKey = localDayKey(endIncl, tzOf(endIncl))
  const selectsAll = !firstKey || (selFromKey <= firstKey && selToKey >= lastKey)
  const selFrom = selectsAll ? null : selFromKey
  const selTo = selectsAll ? null : selToKey

  const fmt = (v: number) => fmtMetric(v, metric)
  const levelTitles = [
    breaks[0] !== undefined ? `〜 ${fmt(breaks[0])}` : '少ない',
    breaks[1] !== undefined ? `${fmt(breaks[0]!)} 〜 ${fmt(breaks[1])}` : '',
    breaks[2] !== undefined ? `${fmt(breaks[1]!)} 〜 ${fmt(breaks[2])}` : '',
    breaks[2] !== undefined ? `${fmt(breaks[2])} 〜` : '多い',
  ]

  if (!firstKey) {
    return (
      <div className="cal">
        <p className="cal__note">記録がありません。</p>
      </div>
    )
  }

  return (
    <div className="cal">
      <div className="segmented cal__metric" role="group" aria-label="色で表す指標">
        {METRICS.map((m) => (
          <button
            key={m.id}
            className={metric === m.id ? 'is-active' : ''}
            aria-pressed={metric === m.id}
            onClick={() => setMetric(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="cal-legend">
        <span className="cal-legend__item" title="記録の無い日">
          <i className="cal-sw is-empty" />
          記録なし
        </span>
        <span className="cal-legend__item" title="記録はあるが値が 0 の日">
          <i className="cal-sw l0" />0
        </span>
        <span className="cal-legend__item cal-legend__ramp">
          少ない
          {[1, 2, 3, 4].map((l) => (
            <i key={l} className={`cal-sw l${l}`} title={levelTitles[l - 1] || undefined} />
          ))}
          多い
        </span>
      </div>

      <p className="cal__sel" aria-live="polite">
        {selectsAll ? (
          '全期間を選択中。日を押すとその日だけを選びます。'
        ) : (
          <>
            選択中: {selFromKey === selToKey ? dayLabel(selFromKey) : `${selFromKey} 〜 ${selToKey}`}
            <button
              className="cal__all"
              onClick={() => {
                anchorRef.current = null
                onSelectRef.current({ start: dataset.tMin, end: dataset.tMax + 1 })
              }}
            >
              全期間に戻す
            </button>
          </>
        )}
      </p>

      <div className="cal__years">
        {grids.map((g) => {
          // 選択範囲を年ごとに切り詰めて渡す。範囲に掛からない年は null のまま変わらないので、
          // 日を選び直しても描き直すのは前後の選択に掛かる年だけで済む
          const jan1 = `${g.year}-01-01`
          const dec31 = `${g.year}-12-31`
          const yFrom = selFrom !== null && selFrom > jan1 ? selFrom : jan1
          const yTo = selTo !== null && selTo < dec31 ? selTo : dec31
          const hit = selFrom !== null && yFrom <= yTo
          return (
            <YearBlock
              key={g.year}
              grid={g}
              daily={daily}
              metric={metric}
              breaks={breaks}
              firstKey={firstKey}
              lastKey={lastKey}
              selFrom={hit ? yFrom : null}
              selTo={hit ? yTo : null}
              cursor={cursor && cursor.startsWith(`${g.year}-`) ? cursor : null}
              onPick={pick}
              onCursor={setCursor}
              onSelectYear={selectYear}
            />
          )
        })}
      </div>

      <p className="cal__readout" aria-live="polite">
        {cursor ? describeDay(cursor, daily.get(cursor), ' · ') : 'クリックや矢印キーで選んだ日の値がここに出ます（升目に合わせるとツールチップでも見られます）。'}
      </p>

      <p className="cal__note">
        {METRIC_NOTES[metric]}
        色は 0 を除いた全期間の値の四分位で 4 段階に分けています（飛行機の日のような極端な日があっても他の日が潰れないように）。
        <b>記録の無い日</b>は薄い空白、「0」は記録はあるが値が 0 の日です。縦は日曜（上）〜土曜（下）。
        日を押すとその日を選択、Shift+クリックで範囲、年の数字で 1 年分を選びます。
      </p>
    </div>
  )
}
