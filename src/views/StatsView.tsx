/**
 * 統計ビュー（DESIGN.md §5 #8）。選択中の期間について、移動距離・交通手段・時間帯・曜日・
 * 新しい場所を小さなグラフで出す。
 *
 * どの数字も「記録された範囲の合計」でしかない（DESIGN.md §1.2.1: 記録の濃さが年で 2.5 倍違う）。
 * だから合計を出すところには必ず、何を数えたか・何に左右されるかを書き添える。
 * グラフは依存を増やさないよう素の SVG と CSS の棒で描く。
 */
import { useMemo, useState, type CSSProperties, type JSX } from 'react'
import type { Dataset, TimeWindow, YearCoverage } from '../core/types'
import { createTzLookup } from '../core/timezone'
import { localDayKey } from '../core/geo'
import {
  MODE_LABELS,
  MOVING_MIN_KMH,
  WEEKDAY_LABELS,
  activityProfile,
  distanceByYear,
  modeBreakdown,
  newPlacesByYear,
} from '../core/stats'
import './StatsView.css'

const nf0 = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 })

/** 100 km 未満だけ小数 1 桁（短い期間でも 0 に丸まらないように） */
function fmtKm(km: number): string {
  return km >= 100 ? nf0.format(km) : nf1.format(km)
}

function fmtHours(sec: number): string {
  if (sec < 3600) return `${nf0.format(sec / 60)} 分`
  const h = sec / 3600
  return `${h >= 100 ? nf0.format(h) : nf1.format(h)} 時間`
}

function fmtNum(v: number): string {
  return v >= 10 ? nf0.format(v) : nf1.format(v)
}

/**
 * 目盛りの上端を切りのいい数に切り上げる。1・2・5 刻みだと 510 → 1,000 のように
 * グラフの上半分が空くので、半分の目盛りも切りのいい数になる範囲で細かく刻む。
 */
const NICE_STEPS = [1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10]
function niceCeil(v: number): number {
  if (!(v > 0)) return 1
  const exp = 10 ** Math.floor(Math.log10(v))
  const f = v / exp
  return NICE_STEPS.find((s) => f <= s + 1e-9)! * exp
}

function argmax(values: number[]): number {
  let best = 0
  for (let i = 1; i < values.length; i++) if (values[i]! > values[best]!) best = i
  return best
}

// ---------------------------------------------------------------------------
// 横棒（年・交通手段）
// ---------------------------------------------------------------------------

interface HBarRow {
  key: string
  label: string
  /** 積み上げる値。0 の部分は描かない */
  parts: { value: number; series: 's1' | 's2' }[]
  display: string
  /** 右端の補足列（記録の濃さなど） */
  extra?: string
  title: string
}

function HBars(props: {
  rows: HBarRow[]
  ariaLabel: string
  /** 見出し行 [ラベル列, 値列, 補足列] */
  head?: [string, string, string?]
  labelWidth?: string
}): JSX.Element {
  const { rows, ariaLabel, head, labelWidth } = props
  const hasExtra = rows.some((r) => r.extra !== undefined)
  let max = 0
  for (const r of rows) max = Math.max(max, r.parts.reduce((a, p) => a + p.value, 0))
  const cls = `sv-hbars${hasExtra ? ' sv-hbars--extra' : ''}`
  const style = labelWidth ? ({ '--sv-label-w': labelWidth } as CSSProperties) : undefined
  return (
    <div className={cls} style={style} role="img" aria-label={ariaLabel}>
      {head && (
        <div className="sv-hbar sv-hbar--head" aria-hidden="true">
          <span>{head[0]}</span>
          <span />
          <span className="sv-hbar__value">{head[1]}</span>
          {hasExtra && <span className="sv-hbar__extra">{head[2] ?? ''}</span>}
        </div>
      )}
      {rows.map((r) => {
        const parts = r.parts.filter((p) => p.value > 0)
        return (
          <div key={r.key} className="sv-hbar" title={r.title}>
            <span className="sv-hbar__label">{r.label}</span>
            <span className="sv-hbar__track">
              {parts.map((p, i) => (
                <span
                  key={i}
                  className={`sv-hbar__part is-${p.series}`}
                  // 隙間 2px ぶんを引いた幅で按分し、最長の棒でも枠からはみ出さない
                  style={{ width: `calc((100% - ${(parts.length - 1) * 2}px) * ${max > 0 ? p.value / max : 0})` }}
                />
              ))}
            </span>
            <span className="sv-hbar__value">{r.display}</span>
            {hasExtra && <span className="sv-hbar__extra">{r.extra ?? ''}</span>}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 縦棒（時間帯・曜日）。移動中／停止中の 2 系列を積み上げる
// ---------------------------------------------------------------------------

const COL_W = 290
const COL_H = 116
const PAD_L = 26
const PAD_R = 2
const PAD_T = 6
const PAD_B = 16

/** 上だけ角を丸めた棒（データの端だけ丸め、基線側は四角のまま） */
function topRoundedBar(x: number, y: number, w: number, h: number): string {
  const r = Math.max(0, Math.min(3, w / 2 - 0.5, h))
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

function StackedColumns(props: {
  labels: string[]
  /** この間隔ごとに x 軸のラベルを出す */
  labelEvery: number
  moving: number[]
  still: number[]
  titles: string[]
  ariaLabel: string
}): JSX.Element {
  const { labels, labelEvery, moving, still, titles, ariaLabel } = props
  const n = labels.length
  let maxSec = 0
  for (let i = 0; i < n; i++) maxSec = Math.max(maxSec, moving[i]! + still[i]!)
  // 短い期間（1 日など）は時間だと目盛りが 0.x ばかりになるので分に切り替える
  const unitSec = maxSec < 3600 ? 60 : 3600
  const unitName = unitSec === 60 ? '分' : '時間'
  const top = niceCeil(maxSec / unitSec)
  const plotW = COL_W - PAD_L - PAD_R
  const plotH = COL_H - PAD_T - PAD_B
  const slot = plotW / n
  const barW = Math.min(24, slot - 2)
  const base = PAD_T + plotH
  const yOf = (sec: number) => (sec / unitSec / top) * plotH

  return (
    <figure className="sv-fig">
      <svg
        className="sv-cols"
        viewBox={`0 0 ${COL_W} ${COL_H}`}
        role="img"
        aria-label={`${ariaLabel}（縦軸の単位: ${unitName}）`}
      >
        {[top / 2, top].map((v) => {
          const y = base - (v / top) * plotH
          return (
            <g key={v}>
              <line className="sv-cols__grid" x1={PAD_L} x2={COL_W - PAD_R} y1={y} y2={y} />
              <text className="sv-cols__tick" x={PAD_L - 4} y={y + 3.5} textAnchor="end">
                {fmtNum(v)}
              </text>
            </g>
          )
        })}
        <text className="sv-cols__tick" x={PAD_L - 4} y={base + 3.5} textAnchor="end">
          0
        </text>
        {labels.map((label, i) => {
          const x = PAD_L + i * slot + (slot - barW) / 2
          const hMove = yOf(moving[i]!)
          const hStill = yOf(still[i]!)
          // 系列の間に 2px の隙間（面の色）を空けて、隣り合う塗りを線なしで分ける。
          // 隙間は上の段から削る（棒全体の高さは目盛りどおりに保つ）
          const gap = hMove > 0.5 ? 2 : 0
          const hStillDrawn = hStill - gap
          const topIsStill = hStillDrawn > 0.5
          return (
            <g key={i} className="sv-cols__col">
              <title>{titles[i]}</title>
              <rect className="sv-cols__hit" x={PAD_L + i * slot} y={PAD_T} width={slot} height={plotH} />
              {hMove > 0.5 &&
                (topIsStill ? (
                  <rect className="is-s1" x={x} y={base - hMove} width={barW} height={hMove} />
                ) : (
                  <path className="is-s1" d={topRoundedBar(x, base - hMove, barW, hMove)} />
                ))}
              {topIsStill && (
                <path className="is-s2" d={topRoundedBar(x, base - hMove - hStill, barW, hStillDrawn)} />
              )}
              {i % labelEvery === 0 && (
                <text className="sv-cols__label" x={PAD_L + i * slot + slot / 2} y={COL_H - 3} textAnchor="middle">
                  {label}
                </text>
              )}
            </g>
          )
        })}
        <line className="sv-cols__base" x1={PAD_L} x2={COL_W - PAD_R} y1={base} y2={base} />
      </svg>
      <figcaption className="sv-legend">
        <span>
          <i className="sv-legend__key is-s1" />
          移動中（時速 {MOVING_MIN_KMH} km 以上）
        </span>
        <span>
          <i className="sv-legend__key is-s2" />
          停止中
        </span>
        <span className="sv-legend__unit">単位: {unitName}</span>
      </figcaption>
    </figure>
  )
}

/** グラフと同じ値の表（ツールチップが使えない環境でも数値を読めるように） */
function ProfileTable(props: { labels: string[]; moving: number[]; still: number[]; days?: number[] }) {
  const { labels, moving, still, days } = props
  return (
    <details className="sv-details">
      <summary>数値で見る</summary>
      <table className="sv-table">
        <thead>
          <tr>
            <th />
            <th>移動中</th>
            <th>停止中</th>
            {days && <th>記録日</th>}
          </tr>
        </thead>
        <tbody>
          {labels.map((l, i) => (
            <tr key={l}>
              <td>{l}</td>
              <td>{fmtHours(moving[i]!)}</td>
              <td>{fmtHours(still[i]!)}</td>
              {days && <td>{nf0.format(days[i]!)} 日</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export function StatsView(props: { dataset: Dataset; selection: TimeWindow }): JSX.Element {
  const { dataset, selection } = props
  const [modeMetric, setModeMetric] = useState<'distance' | 'time'>('distance')

  const tzOf = useMemo(() => createTzLookup(dataset.tzChanges), [dataset.tzChanges])

  // 期間が変わったときだけ数え直す。軌跡 12 万点を 2 周するので描画ごとには回さない
  const s = useMemo(() => {
    const w = { start: selection.start, end: selection.end }
    return {
      years: distanceByYear(dataset.trips, w, tzOf),
      profile: activityProfile(dataset.trips, w, tzOf),
      modes: modeBreakdown(dataset.moves, w),
      places: newPlacesByYear(dataset.places, w, tzOf),
    }
  }, [dataset, tzOf, selection.start, selection.end])

  const firstMove = useMemo(() => {
    let t = Infinity
    for (const m of dataset.moves) if (m.start < t) t = m.start
    return t
  }, [dataset.moves])

  const coverageByYear = useMemo(() => {
    const m = new Map<number, YearCoverage>()
    for (const c of dataset.coverage) m.set(c.year, c)
    return m
  }, [dataset.coverage])

  const endInclusive = Math.max(selection.start, selection.end - 1)
  const periodFrom = localDayKey(selection.start, tzOf(selection.start))
  const periodTo = localDayKey(endInclusive, tzOf(endInclusive))

  const groundKm = s.years.reduce((a, y) => a + y.groundKm, 0)
  const flightKm = s.years.reduce((a, y) => a + y.flightKm, 0)
  const p = s.profile
  const recordedSec = [...p.hourMovingSec, ...p.hourStillSec].reduce((a, b) => a + b, 0)

  // --- 1. 移動距離 ---
  const yearRows: HBarRow[] = s.years.map((y) => {
    const cov = coverageByYear.get(y.year)
    const covText = cov ? cov.coverageHoursPerDay.toFixed(1) : '—'
    return {
      key: String(y.year),
      label: String(y.year),
      parts: [{ value: y.groundKm, series: 's1' }],
      display: fmtKm(y.groundKm),
      extra: covText,
      title: `${y.year} 年 · 地上 ${fmtKm(y.groundKm)} km · 飛行 ${fmtKm(y.flightKm)} km${
        cov ? ` · 記録のある日 ${nf0.format(cov.recordedDays)} 日・1 日あたり ${covText} 時間ぶんの記録` : ''
      }`,
    }
  })

  // --- 2. 交通手段別 ---
  const modes = [...s.modes].sort((a, b) =>
    modeMetric === 'distance' ? b.meters - a.meters : b.seconds - a.seconds,
  )
  const modeRows: HBarRow[] = modes.map((m) => ({
    key: m.mode,
    label: MODE_LABELS[m.mode],
    parts: [{ value: modeMetric === 'distance' ? m.meters : m.seconds, series: 's1' }],
    display: modeMetric === 'distance' ? `${fmtKm(m.meters / 1000)} km` : fmtHours(m.seconds),
    title: `${MODE_LABELS[m.mode]} · ${fmtKm(m.meters / 1000)} km · ${fmtHours(m.seconds)} · ${nf0.format(m.count)} 回`,
  }))

  // --- 3・4. 時間帯・曜日 ---
  const hourLabels = Array.from({ length: 24 }, (_, h) => String(h))
  const hourTitles = hourLabels.map(
    (_, h) => `${h} 時台 · 移動中 ${fmtHours(p.hourMovingSec[h]!)} · 停止中 ${fmtHours(p.hourStillSec[h]!)}`,
  )
  const hourTotal = p.hourMovingSec.map((v, h) => v + p.hourStillSec[h]!)
  const peakMoveHour = argmax(p.hourMovingSec)
  const peakHour = argmax(hourTotal)
  const wdLabels = [...WEEKDAY_LABELS]
  const wdTitles = wdLabels.map(
    (l, i) =>
      `${l}曜 · 移動中 ${fmtHours(p.weekdayMovingSec[i]!)} · 停止中 ${fmtHours(p.weekdayStillSec[i]!)} · 記録のあった日 ${nf0.format(p.weekdayDays[i]!)} 日`,
  )
  const peakMoveWd = argmax(p.weekdayMovingSec)

  // --- 5. 新しい場所 ---
  const placeTotal = s.places.reduce((a, y) => a + y.google + y.derived, 0)
  const placeRows: HBarRow[] = s.places.map((y) => ({
    key: String(y.year),
    label: String(y.year),
    parts: [
      { value: y.google, series: 's1' },
      { value: y.derived, series: 's2' },
    ],
    display: nf0.format(y.google + y.derived),
    title: `${y.year} 年 · Google の訪問 ${nf0.format(y.google)} か所 · 軌跡から復元 ${nf0.format(y.derived)} か所`,
  }))

  return (
    <div className="sv">
      <p className="sv__period">
        {periodFrom} 〜 {periodTo}（記録側の暦日）
      </p>

      <section className="sv__section" aria-labelledby="sv-distance">
        <h3 className="sv__title" id="sv-distance">
          移動距離
        </h3>
        <div className="sv__tiles">
          <div className="sv-tile">
            <span className="sv-tile__label">地上</span>
            <span className="sv-tile__value">
              {fmtKm(groundKm)}
              <span className="sv-tile__unit">km</span>
            </span>
          </div>
          <div className="sv-tile">
            <span className="sv-tile__label">飛行</span>
            <span className="sv-tile__value">
              {fmtKm(flightKm)}
              <span className="sv-tile__unit">km</span>
            </span>
          </div>
        </div>
        {yearRows.length >= 2 ? (
          <HBars
            rows={yearRows}
            head={['年', '地上 km', '時間/日']}
            ariaLabel={`年ごとの地上の移動距離: ${s.years
              .map((y) => `${y.year} 年 ${fmtKm(y.groundKm)} km`)
              .join('、')}`}
          />
        ) : (
          yearRows.length === 1 &&
          yearRows[0]!.extra !== '—' && (
            <p className="sv__note">
              {yearRows[0]!.label} 年は、記録のある日 1 日あたり {yearRows[0]!.extra} 時間ぶんの記録があります。
            </p>
          )
        )}
        <p className="sv__note">
          軌跡の点と点の間の直線距離の合計です。年ごとの合計は<b>記録の濃さ</b>
          （右端の「時間/日」: 記録のある日 1 日あたり何時間ぶんの軌跡があるか）に左右され、
          記録の薄い年は同じ暮らしでも短く出ます。飛行は大圏補間で埋めた区間（点の間が 2 km 超）で、地上には入れていません。
        </p>
      </section>

      <section className="sv__section" aria-labelledby="sv-modes">
        <div className="sv__head">
          <h3 className="sv__title" id="sv-modes">
            交通手段別
          </h3>
          {modeRows.length > 0 && (
            <div className="segmented sv__seg" role="group" aria-label="交通手段別の指標">
              <button
                className={modeMetric === 'distance' ? 'is-active' : ''}
                aria-pressed={modeMetric === 'distance'}
                onClick={() => setModeMetric('distance')}
              >
                距離
              </button>
              <button
                className={modeMetric === 'time' ? 'is-active' : ''}
                aria-pressed={modeMetric === 'time'}
                onClick={() => setModeMetric('time')}
              >
                時間
              </button>
            </div>
          )}
        </div>
        {modeRows.length > 0 ? (
          <>
            <HBars
              rows={modeRows}
              labelWidth="64px"
              ariaLabel={`交通手段別の${modeMetric === 'distance' ? '距離' : '時間'}: ${modeRows
                .map((r) => `${r.label} ${r.display}`)
                .join('、')}`}
            />
            <p className="sv__note">
              Google が移動区間に付けた交通手段の推定です（距離も Google の値）。
              {selection.start < firstMove && (
                <>
                  <b className="sv__warn">{localDayKey(firstMove, tzOf(firstMove))} より前</b>
                  は交通手段のデータが無いので、この集計に入っていません。
                </>
              )}
            </p>
          </>
        ) : (
          <p className="sv__note">
            この期間には交通手段のデータがありません。交通手段は Google の移動区間に付いた情報で、
            <b className="sv__warn">2024 年秋以降のみ</b>あります。
          </p>
        )}
      </section>

      <section className="sv__section" aria-labelledby="sv-hours">
        <h3 className="sv__title" id="sv-hours">
          時間帯
        </h3>
        {recordedSec > 0 ? (
          <>
            <StackedColumns
              labels={hourLabels}
              labelEvery={3}
              moving={p.hourMovingSec}
              still={p.hourStillSec}
              titles={hourTitles}
              ariaLabel={`時間帯別の記録時間。移動中がいちばん多いのは ${peakMoveHour} 時台（${fmtHours(
                p.hourMovingSec[peakMoveHour]!,
              )}）、記録がいちばん多いのは ${peakHour} 時台（${fmtHours(hourTotal[peakHour]!)}）`}
            />
            <ProfileTable labels={hourTitles.map((_, h) => `${h} 時`)} moving={p.hourMovingSec} still={p.hourStillSec} />
          </>
        ) : (
          <p className="sv__note">この期間には軌跡がありません。</p>
        )}
        <p className="sv__note">
          軌跡の点と点の間の時間を、記録側の現地時刻で 1 時間ごとに足したものです（点の数ではなく時間。
          点の間隔が 30 分を超える分と飛行の補間区間は数えません）。止まっている間は記録が残りにくいので、停止中は少なめに出ます。
        </p>
      </section>

      <section className="sv__section" aria-labelledby="sv-weekdays">
        <h3 className="sv__title" id="sv-weekdays">
          曜日
        </h3>
        {recordedSec > 0 ? (
          <>
            <StackedColumns
              labels={wdLabels}
              labelEvery={1}
              moving={p.weekdayMovingSec}
              still={p.weekdayStillSec}
              titles={wdTitles}
              ariaLabel={`曜日別の記録時間。移動中がいちばん多いのは${wdLabels[peakMoveWd]}曜（${fmtHours(
                p.weekdayMovingSec[peakMoveWd]!,
              )}）`}
            />
            <ProfileTable
              labels={wdLabels.map((l) => `${l}曜`)}
              moving={p.weekdayMovingSec}
              still={p.weekdayStillSec}
              days={p.weekdayDays}
            />
          </>
        ) : (
          <p className="sv__note">この期間には軌跡がありません。</p>
        )}
        <p className="sv__note">
          時間帯と同じ数え方の曜日別の合計です。短い期間では曜日ごとの日数が揃わないので、
          「記録日」（その曜日で記録のあった日数）と合わせて読んでください。
        </p>
      </section>

      <section className="sv__section" aria-labelledby="sv-places">
        <h3 className="sv__title" id="sv-places">
          新しい場所
        </h3>
        {placeTotal > 0 ? (
          <>
            <p className="sv__lead">
              期間中に初めて訪れた場所 <b>{nf0.format(placeTotal)}</b> か所
            </p>
            {placeRows.length >= 2 ? (
              <>
                <HBars
                  rows={placeRows}
                  head={['年', 'か所']}
                  ariaLabel={`年ごとの新しい場所: ${s.places
                    .map((y) => `${y.year} 年 ${y.google + y.derived} か所（うち復元 ${y.derived}）`)
                    .join('、')}`}
                />
                <div className="sv-legend">
                  <span>
                    <i className="sv-legend__key is-s1" />
                    Google の訪問
                  </span>
                  <span>
                    <i className="sv-legend__key is-s2" />
                    軌跡から復元
                  </span>
                </div>
              </>
            ) : (
              <p className="sv__note">
                うち Google の訪問 {nf0.format(s.places[0]?.google ?? 0)} か所・軌跡から復元{' '}
                {nf0.format(s.places[0]?.derived ?? 0)} か所
              </p>
            )}
          </>
        ) : (
          <p className="sv__note">この期間に初めて訪れた場所はありません。</p>
        )}
        <p className="sv__note">
          「初めて」は全期間を通しての初訪問です。「軌跡から復元」は Google の訪問データが無い
          <b className="sv__warn">2024 年秋より前</b>だけにあり、軌跡が止まっていた所から作った粗い場所です
          （同じ場所が別の場所として数えられることがあります）。
        </p>
      </section>
    </div>
  )
}
