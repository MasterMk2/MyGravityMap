/**
 * 場所ランキング（DESIGN.md §5 ビュー #3）。期間スライダーに連動し、ラベル編集もここで行う。
 *
 * 並べ替えの軸は 3 つ:
 * - 日数: 訪れた日の数。記録の濃さに左右されにくく、全期間で比べられる（§2 頻度モード）
 * - 時間: Google の訪問データの滞在時間。2024 年秋より前には存在しない（§1.2）
 * - 回数: 訪問の件数。短い立ち寄りも 1 回に数える
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Dataset, Place, TimeWindow } from '../core/types'
import {
  coordHint,
  hasReliableTime,
  isDerivedOnly,
  placeName,
  placesInWindow,
  sortPlaces,
  type PlaceSort,
} from '../core/ranking'
import { useLabels } from '../store/labels'
import './PlacesView.css'

interface Props {
  dataset: Dataset
  selection: TimeWindow
  onFocus: (lon: number, lat: number, zoom?: number) => void
}

/** 一覧に出す行数。これより下は地図の重力マップで見れば足りる */
const MAX_ROWS = 100
/** 行を押したときのズーム。建物が見分けられる程度 */
const FOCUS_ZOOM = 15
/** ラベルの最大文字数。パネル幅（約 290px）で読める長さの上限の目安 */
const LABEL_MAX = 60

const nf = new Intl.NumberFormat('ja-JP')
const NO_LABELS: Record<string, string> = {}

const SORTS: { id: PlaceSort; label: string }[] = [
  { id: 'days', label: '日数' },
  { id: 'time', label: '時間' },
  { id: 'count', label: '回数' },
]

/** 滞在時間の表示。信頼できる時間が無いものは 0 ではなく「—」（測れていないだけなので） */
function formatDuration(sec: number): string {
  if (sec <= 0) return '—'
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} 分`
  const h = sec / 3600
  return h < 10 ? `${h.toFixed(1)} 時間` : `${nf.format(Math.round(h))} 時間`
}

function sortHint(sort: PlaceSort, timeAvailable: boolean, anyWithoutTime: boolean): string {
  if (!timeAvailable) return 'この期間には滞在時間の記録がありません（時間は 2024 年秋以降のみ）'
  if (sort === 'time') {
    return anyWithoutTime
      ? '時間は 2024 年秋以降の Google の訪問データだけで数えます。時間の無い場所は末尾に並びます'
      : '時間は 2024 年秋以降の Google の訪問データだけで数えます'
  }
  if (sort === 'days') return '日数 = 訪れた日の数（同じ日の再訪は 1 日）'
  return '回数 = 訪問の件数（短い立ち寄りも 1 回）'
}

export function PlacesView({ dataset, selection, onFocus }: Props) {
  const labels = useLabels((s) => s.labels)
  const labelError = useLabels((s) => s.error)
  const load = useLabels((s) => s.load)
  const setLabel = useLabels((s) => s.setLabel)
  useEffect(() => {
    void load()
  }, [load])

  const [sortBy, setSortBy] = useState<PlaceSort>('days')
  const [editing, setEditing] = useState<string | null>(null)
  /** キーボードで編集を終えたら ✎ にフォーカスを戻す（どこまで操作したか見失わないように） */
  const returnFocusTo = useRef<string | null>(null)

  // 期間スライダーを引きずっている間も操作が詰まらないよう、集計は一拍遅れてよい
  const deferred = useDeferredValue(selection)
  const { start, end } = deferred
  const inWindow = useMemo(
    () => placesInWindow(dataset.visits, { start, end }),
    [dataset.visits, start, end],
  )
  const timeAvailable = useMemo(() => hasReliableTime(inWindow), [inWindow])
  const anyWithoutTime = useMemo(() => inWindow.some((p) => p.reliableSeconds <= 0), [inWindow])
  // 時間を選んだまま時間の無い期間へ動かしたら、選択は覚えたまま日数で見せる
  const sort: PlaceSort = sortBy === 'time' && !timeAvailable ? 'days' : sortBy
  const ranked = useMemo(() => sortPlaces(inWindow, sort), [inWindow, sort])
  const rows = ranked.slice(0, MAX_ROWS)

  const finishEdit = (id: string, value: string | null, via: 'key' | 'blur') => {
    if (value !== null) void setLabel(id, value)
    if (via === 'key') returnFocusTo.current = id
    setEditing((cur) => (cur === id ? null : cur))
  }

  return (
    <div className="placesView">
      <div className="segmented" role="group" aria-label="場所の並べ替え">
        {SORTS.map((s) => {
          const disabled = s.id === 'time' && !timeAvailable
          return (
            <button
              key={s.id}
              className={sort === s.id ? 'is-active' : ''}
              aria-pressed={sort === s.id}
              disabled={disabled}
              title={
                disabled
                  ? 'この期間には Google の訪問データが無いので、時間では並べられません'
                  : undefined
              }
              onClick={() => setSortBy(s.id)}
            >
              {s.label}
            </button>
          )
        })}
      </div>
      <p className="placesView__hint">{sortHint(sort, timeAvailable, anyWithoutTime)}</p>

      <p className="placesView__count">
        期間内 {nf.format(ranked.length)} か所
        {ranked.length > MAX_ROWS && `（上位 ${MAX_ROWS} を表示）`}
      </p>

      {rows.length === 0 ? (
        <p className="placesView__empty">この期間には滞在の記録がありません</p>
      ) : (
        <ol className="placesView__list">
          {rows.map((p, i) => {
            const rank = i + 1
            const name = placeName(p, rank, labels, dataset.anchors)
            return (
              <li key={p.id} className="placesView__item">
                {editing === p.id ? (
                  <>
                    <span className="placesView__rank">{rank}</span>
                    <LabelInput
                      initial={labels[p.id] ?? ''}
                      // 空にして保存したときに戻る名前を見せておく
                      placeholder={placeName(p, rank, NO_LABELS, dataset.anchors).text}
                      onDone={(value, via) => finishEdit(p.id, value, via)}
                    />
                  </>
                ) : (
                  <>
                    <button
                      className="placesView__row"
                      title="地図でこの場所へ移動"
                      onClick={() => onFocus(p.lon, p.lat, FOCUS_ZOOM)}
                    >
                      <span className="placesView__rank">{rank}</span>
                      <span className="placesView__body">
                        <span className="placesView__nameLine">
                          <span className="placesView__name">{name.text}</span>
                          {name.kind === 'fallback' && (
                            <span className="placesView__coord">{coordHint(p)}</span>
                          )}
                          {isDerivedOnly(p) && (
                            <span
                              className="placesView__badge"
                              title="軌跡から推定した滞在だけの場所です（滞在時間は測れません）"
                            >
                              推定
                            </span>
                          )}
                        </span>
                        <PlaceMeta place={p} sort={sort} />
                      </span>
                    </button>
                    <button
                      className="placesView__edit"
                      aria-label={`「${name.text}」の名前を編集`}
                      title="名前を付ける"
                      ref={(el) => {
                        if (el && returnFocusTo.current === p.id) {
                          returnFocusTo.current = null
                          el.focus()
                        }
                      }}
                      onClick={() => setEditing(p.id)}
                    >
                      ✎
                    </button>
                  </>
                )}
              </li>
            )
          })}
        </ol>
      )}

      {labelError && <p className="placesView__note warn">ラベルを保存できませんでした: {labelError}</p>}
      <p className="placesView__note">
        ✎ で名前を付けられます。ラベルはこの端末のブラウザにだけ保存されます
      </p>
    </div>
  )
}

function PlaceMeta({ place, sort }: { place: Place; sort: PlaceSort }) {
  // いま並べている軸だけ明るくして、順位の根拠がどの数字か分かるようにする
  const key = (s: PlaceSort) => (sort === s ? 'is-key' : undefined)
  return (
    <span className="placesView__meta">
      <span className={key('days')}>{nf.format(place.visitDays)} 日</span>
      {' · '}
      <span className={key('time')}>{formatDuration(place.reliableSeconds)}</span>
      {' · '}
      <span className={key('count')}>{nf.format(place.visitCount)} 回</span>
    </span>
  )
}

/**
 * ラベルの入力欄。Enter で保存、Esc で取り消し、フォーカスが外れたら保存。
 * 空にして保存すると利用者のラベルを消して自動ラベル／「場所 #n」の表示に戻る。
 */
function LabelInput({
  initial,
  placeholder,
  onDone,
}: {
  initial: string
  placeholder: string
  onDone: (value: string | null, via: 'key' | 'blur') => void
}) {
  // Enter / Esc で閉じると入力欄が消えるときに blur も飛んでくることがある。
  // 二重に保存したり、取り消したのに blur 側で保存したりしないよう、最初の 1 回だけ通す
  const done = useRef(false)
  const finish = (value: string | null, via: 'key' | 'blur') => {
    if (done.current) return
    done.current = true
    onDone(value, via)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 日本語入力の変換確定の Enter で保存しない。Safari は確定後の keydown で
    // isComposing が false になることがあるので keyCode 229 も見る
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      finish(e.currentTarget.value, 'key')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      finish(null, 'key')
    }
  }

  return (
    <input
      className="placesView__input"
      type="text"
      autoFocus
      defaultValue={initial}
      placeholder={placeholder}
      maxLength={LABEL_MAX}
      aria-label="場所の名前（空にすると元の表示に戻ります。Enter で保存、Esc で取り消し）"
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={onKeyDown}
      onBlur={(e) => finish(e.currentTarget.value, 'blur')}
    />
  )
}
