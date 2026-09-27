import { useMemo, useState } from 'react'
import type { Dataset, TimeWindow } from '../core/types'
import { bearingDeg, compassJa } from '../core/barycenter'
import { expeditionYear, findExpeditions, type Expedition } from '../core/expeditions'
import './views-geo.css'

interface Props {
  dataset: Dataset
  selection: TimeWindow
  onSelectWindow: (w: TimeWindow) => void
  onFitBounds: (bbox: [number, number, number, number]) => void
}

/** 遠出とみなす距離の選択肢（km） */
const THRESHOLDS = [50, 100, 300, 1000] as const
type Threshold = (typeof THRESHOLDS)[number]

/**
 * 再生期間の前後に足す余白。遠征は暦日単位で切っているので、日付をまたいで
 * 帰宅した夜の移動や、前夜の出発が期間の外に落ちないようにする。
 */
const PAD_SEC = 3 * 3600

const nf = new Intl.NumberFormat('ja-JP')

function rangeLabel(e: Expedition): string {
  if (e.startDay === e.endDay) return e.startDay
  // 同じ年なら終わりの年を省く（2023-08-12〜08-15）
  const sameYear = e.startDay.slice(0, 4) === e.endDay.slice(0, 4)
  return `${e.startDay}〜${sameYear ? e.endDay.slice(5) : e.endDay}`
}

export function ExpeditionsView({ dataset, selection, onSelectWindow, onFitBounds }: Props) {
  const [minKm, setMinKm] = useState<Threshold>(50)
  const list = useMemo(() => findExpeditions(dataset, { minKm }), [dataset, minKm])

  // 新しい順のまま年ごとにまとめる
  const groups = useMemo(() => {
    const out: Array<{ year: number; items: Expedition[]; days: number }> = []
    for (const e of list) {
      const year = expeditionYear(e)
      let g = out[out.length - 1]
      if (!g || g.year !== year) {
        g = { year, items: [], days: 0 }
        out.push(g)
      }
      g.items.push(e)
      g.days += e.days
    }
    return out
  }, [list])

  const totalDays = useMemo(() => list.reduce((sum, e) => sum + e.days, 0), [list])

  // 全期間を選んでいるときは全件が「期間内」になり、強調の意味が無くなるので強調しない
  const narrowed = selection.start > dataset.tMin || selection.end < dataset.tMax
  const isActive = (e: Expedition) =>
    narrowed && e.start < selection.end && e.end > selection.start
  const activeCount = narrowed ? list.filter(isActive).length : 0

  const open = (e: Expedition) => {
    onSelectWindow({
      start: Math.max(dataset.tMin, e.start - PAD_SEC),
      end: Math.min(dataset.tMax, e.end + PAD_SEC),
    })
    onFitBounds(e.bbox)
  }

  return (
    <div className="geo-view">
      <div className="segmented" role="group" aria-label="遠出とみなす自宅からの距離">
        {THRESHOLDS.map((t) => (
          <button
            key={t}
            className={minKm === t ? 'is-active' : ''}
            aria-pressed={minKm === t}
            onClick={() => setMinKm(t)}
          >
            {nf.format(t)}km
          </button>
        ))}
      </div>

      <p className="exped-summary">
        自宅から {nf.format(minKm)} km 超: <em>{nf.format(list.length)}</em> 件・合計{' '}
        <em>{nf.format(totalDays)}</em> 日
        {narrowed && <>（選択中の期間に {nf.format(activeCount)} 件）</>}
      </p>

      <p className="geo-note">
        軌跡から判定するので全期間で使えます。ただし 2024 年より前は記録がまばらで、短い遠出は漏れることがあります。
        場所の名前はデータに無いため、自宅からの距離と方角で示します。
      </p>

      {list.length === 0 && (
        <p className="exped-empty">{nf.format(minKm)} km を超える遠出は見つかりませんでした。</p>
      )}

      {groups.map((g) => (
        <section key={g.year}>
          <h4 className="exped-year">
            <strong>{g.year}</strong>
            <span>
              {nf.format(g.items.length)} 件・{nf.format(g.days)} 日
            </span>
          </h4>
          <ul className="exped-list">
            {g.items.map((e) => (
              <li key={e.start}>
                <button
                  className={`exped-row${isActive(e) ? ' is-active' : ''}`}
                  aria-current={isActive(e) ? 'true' : undefined}
                  title="この期間を再生範囲にして地図を合わせる"
                  onClick={() => open(e)}
                >
                  <span className="exped-date">
                    {rangeLabel(e)}
                    <span className="exped-days">
                      （{e.days === 1 ? '日帰り' : `${e.days}日`}）
                    </span>
                  </span>
                  {e.hasFlight ? (
                    <span className="exped-flight" title="飛行機の区間を含む" aria-label="飛行機の区間を含む">
                      {'✈︎'}
                    </span>
                  ) : (
                    <span />
                  )}
                  <span className="exped-meta">
                    最遠 {nf.format(Math.round(e.maxKm))} km・{compassJa(bearingDeg(e.home, e.farthest))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
