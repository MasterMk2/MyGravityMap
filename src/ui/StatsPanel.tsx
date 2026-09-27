import { useState } from 'react'
import type { Dataset, TimeWindow } from '../core/types'
import type { BasemapId } from '../map/basemaps'
import { BASEMAPS, BASEMAP_ORDER } from '../map/basemaps'
import { isDemoDataset, useAppStore } from '../store/useAppStore'
import { GravityControls } from './GravityControls'
import { LicenseLinks } from './About'
import { DataManager } from './DataManager'
import { PlacesView } from '../views/PlacesView'
import { ExportButtons } from '../views/ExportButtons'
import { StatsView } from '../views/StatsView'
import { CalendarView } from '../views/CalendarView'
import { ExpeditionsView } from '../views/ExpeditionsView'
import { BarycenterView } from '../views/BarycenterView'
import type { YearBarycenter } from '../core/barycenter'
import type { GravitySettings } from '../gravity/layers'
import type { WeightedPoints } from '../gravity/weights'

interface Props {
  dataset: Dataset
  /** 再生バーで選んでいる期間。場所・統計・遠征はこの期間で数える */
  selection: TimeWindow
  onSelectWindow: (w: TimeWindow) => void
  basemap: BasemapId
  onBasemapChange: (b: BasemapId) => void
  /** 地図を沈める量 0..0.85 */
  dim: number
  onDimChange: (v: number) => void
  onFocus: (lon: number, lat: number, zoom?: number) => void
  onFitBounds: (bbox: [number, number, number, number]) => void
  gravity: GravitySettings
  onGravityChange: (patch: Partial<GravitySettings>) => void
  gravityPoints: WeightedPoints
  visitAvailable: boolean
  /** 年ごとの重心を地図に重ねるか */
  showBarycenter: boolean
  onShowBarycenterChange: (v: boolean) => void
  /** App で数えた年ごとの重心（地図に出しているときだけある） */
  barycenters: YearBarycenter[] | undefined
  barycenterYear: number | null
  onBarycenterYearChange: (year: number | null) => void
  /** いま見えている地図を PNG で保存する */
  onExportPng: () => void
  /** パネルを畳む */
  onCollapse: () => void
}

type Tab = 'view' | 'places' | 'stats' | 'calendar' | 'trips' | 'center' | 'summary'

const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'view', label: '表示', hint: '重力マップ・背景の地図・書き出し' },
  { id: 'places', label: '場所', hint: 'よく居た場所のランキングと名前付け' },
  { id: 'stats', label: '統計', hint: '移動距離・交通手段・時間帯' },
  { id: 'calendar', label: 'カレンダー', hint: '日ごとの記録。日を押すとその日を再生' },
  { id: 'trips', label: '遠征', hint: '生活圏から離れた旅行・遠出の一覧' },
  { id: 'center', label: '重心', hint: '年ごとの生活の中心と行動半径' },
  { id: 'summary', label: '概要', hint: '取り込んだデータの内訳と記録の濃さ' },
]

const nf = new Intl.NumberFormat('ja-JP')

function ymd(sec: number): string {
  const d = new Date(sec * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`
}

export function StatsPanel({
  dataset,
  selection,
  onSelectWindow,
  basemap,
  onBasemapChange,
  dim,
  onDimChange,
  onFocus,
  onFitBounds,
  gravity,
  onGravityChange,
  gravityPoints,
  visitAvailable,
  showBarycenter,
  onShowBarycenterChange,
  barycenters,
  barycenterYear,
  onBarycenterYearChange,
  onExportPng,
  onCollapse,
}: Props) {
  const reset = useAppStore((s) => s.reset)
  const fromCache = useAppStore((s) => s.fromCache)
  const [tab, setTab] = useState<Tab>('view')
  const s = dataset.stats
  const demo = isDemoDataset(dataset)

  return (
    <div className="panel">
      <div className="panel__head">
        <strong title={dataset.fileName}>
          {demo && <span className="badge" title="架空の人物の合成データです">デモ</span>}
          {dataset.fileName}
        </strong>
        <span className="panel__headBtns">
          <button onClick={reset}>別のファイル</button>
          <button onClick={onCollapse} title="パネルを畳む（h キーでまとめて切り替え）" aria-label="パネルを畳む">
            ✕
          </button>
        </span>
      </div>

      <div className="panel__tabs" role="tablist" aria-label="パネルの表示内容">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            title={t.hint}
            className={tab === t.id ? 'is-active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* タブの中身をまとめてスクロールさせる。下の再生バーに潜り込まないよう、
          パネル自体の高さは App 側で再生バーの実測高さぶん詰めている */}
      {/* key でタブごとに作り直す。同じ要素を使い回すと、前のタブのスクロール位置のまま開く */}
      <div className="panel__body" role="tabpanel" key={tab}>
        {tab === 'view' && (
          <div className="panel__section">
            <GravityControls
              settings={gravity}
              onChange={onGravityChange}
              points={gravityPoints}
              visitAvailable={visitAvailable}
            />

            {/* ネイティブの select はドロップダウン内の文字色を OS 側が決めてしまい、
                暗いテーマだと白背景に白文字になって読めない。自前のボタンにする。 */}
            <div className="basemaps">
              <span className="basemaps__label">地図</span>
              <div className="basemaps__grid" role="group" aria-label="背景の地図">
                {BASEMAP_ORDER.map((id) => (
                  <button
                    key={id}
                    className={basemap === id ? 'is-active' : ''}
                    aria-pressed={basemap === id}
                    title={BASEMAPS[id].hint}
                    onClick={() => onBasemapChange(id)}
                  >
                    {BASEMAPS[id].label}
                  </button>
                ))}
              </div>
            </div>
            <label className="dim">
              <span>
                地図を沈める <em>{Math.round(dim * 100)}%</em>
              </span>
              <input
                type="range"
                min={0}
                max={0.85}
                step={0.05}
                value={dim}
                onChange={(e) => onDimChange(Number(e.target.value))}
                aria-label="地図の明るさを下げて軌跡を目立たせる"
              />
            </label>

            <div className="exports">
              <span className="exports__label">書き出し</span>
              <button type="button" onClick={onExportPng} title="いま見えている地図と軌跡を画像で保存">
                画像（PNG）
              </button>
              <ExportButtons dataset={dataset} selection={selection} />
            </div>
          </div>
        )}

        {tab === 'places' && <PlacesView dataset={dataset} selection={selection} onFocus={onFocus} />}

        {tab === 'stats' && <StatsView dataset={dataset} selection={selection} />}

        {tab === 'calendar' && (
          <CalendarView dataset={dataset} selection={selection} onSelectWindow={onSelectWindow} />
        )}

        {tab === 'trips' && (
          <ExpeditionsView
            dataset={dataset}
            selection={selection}
            onSelectWindow={onSelectWindow}
            onFitBounds={onFitBounds}
          />
        )}

        {tab === 'center' && (
          <BarycenterView
            dataset={dataset}
            showOnMap={showBarycenter}
            onShowOnMapChange={onShowBarycenterChange}
            onFocus={onFocus}
            {...(barycenters ? { stats: barycenters } : {})}
            selectedYear={barycenterYear}
            onSelectYear={onBarycenterYearChange}
          />
        )}

        {tab === 'summary' && (
          <div className="panel__section">
            <dl className="kv">
              <dt>期間</dt>
              <dd>
                {ymd(dataset.tMin)} 〜 {ymd(dataset.tMax)}
              </dd>
              <dt>セグメント</dt>
              <dd>{nf.format(s.segments)}</dd>
              <dt>軌跡の点</dt>
              <dd>{nf.format(s.timelinePathPoints)}</dd>
              <dt>軌跡（分割後）</dt>
              <dd>{nf.format(dataset.trips.length)} 本</dd>
              <dt>訪問</dt>
              <dd>{nf.format(s.visitSegments)}</dd>
              <dt>移動</dt>
              <dd>{nf.format(s.activitySegments)}</dd>
              <dt>場所</dt>
              <dd>{nf.format(dataset.places.length)}</dd>
              <dt>時刻の重複を修正</dt>
              <dd>{nf.format(s.duplicateTimeFixed)} 点</dd>
              <dt>飛行区間に補間</dt>
              <dd>{nf.format(s.flightPointsInserted)} 点</dd>
              <dt>破棄した rawSignals</dt>
              <dd>{nf.format(s.rawSignalsDiscarded)} 件</dd>
              {fromCache && (
                <>
                  <dt>読み込み</dt>
                  <dd>キャッシュから復元</dd>
                </>
              )}
            </dl>

            <h3 className="panel__h">記録の濃さ</h3>
            <table className="coverage">
              <thead>
                <tr>
                  <th>年</th>
                  <th>記録日数</th>
                  <th>時間/日</th>
                  <th>訪問</th>
                </tr>
              </thead>
              <tbody>
                {dataset.coverage.map((c) => (
                  <tr key={c.year}>
                    <td>{c.year}</td>
                    <td>{c.recordedDays}</td>
                    <td>{c.coverageHoursPerDay.toFixed(1)}</td>
                    <td>{c.hasGoogleVisits ? 'あり' : <span className="warn">なし</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="panel__note">
              年によって 1 日あたりの記録時間が大きく違います。訪問データ「なし」の年は、
              滞在を軌跡から推定しています。
            </p>

            <h3 className="panel__h">この端末のデータ</h3>
            <DataManager />
          </div>
        )}
      </div>

      <div className="panel__foot">
        <LicenseLinks compact />
      </div>
    </div>
  )
}
