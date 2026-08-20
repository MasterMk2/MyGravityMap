import { useState } from 'react'
import type { Dataset } from '../core/types'
import type { BasemapId } from '../map/basemaps'
import { BASEMAPS, BASEMAP_ORDER } from '../map/basemaps'
import { useAppStore } from '../store/useAppStore'
import { GravityControls } from './GravityControls'
import type { GravitySettings } from '../gravity/layers'
import type { WeightedPoints } from '../gravity/weights'

interface Props {
  dataset: Dataset
  basemap: BasemapId
  onBasemapChange: (b: BasemapId) => void
  /** 地図を沈める量 0..0.85 */
  dim: number
  onDimChange: (v: number) => void
  onFocus: (lon: number, lat: number) => void
  gravity: GravitySettings
  onGravityChange: (patch: Partial<GravitySettings>) => void
  gravityPoints: WeightedPoints
  visitAvailable: boolean
}

const nf = new Intl.NumberFormat('ja-JP')


function ymd(sec: number): string {
  const d = new Date(sec * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`
}

function hours(sec: number): string {
  return `${nf.format(Math.round(sec / 3600))} 時間`
}

export function StatsPanel({
  dataset,
  basemap,
  onBasemapChange,
  dim,
  onDimChange,
  onFocus,
  gravity,
  onGravityChange,
  gravityPoints,
  visitAvailable,
}: Props) {
  const reset = useAppStore((s) => s.reset)
  const fromCache = useAppStore((s) => s.fromCache)
  const [tab, setTab] = useState<'summary' | 'places' | 'coverage'>('summary')
  const s = dataset.stats

  return (
    <div className="panel">
      <div className="panel__head">
        <strong>{dataset.fileName}</strong>
        <button onClick={reset}>別のファイル</button>
      </div>

      <div className="panel__tabs">
        {(['summary', 'places', 'coverage'] as const).map((t) => (
          <button
            key={t}
            className={tab === t ? 'is-active' : ''}
            onClick={() => setTab(t)}
          >
            {t === 'summary' ? '概要' : t === 'places' ? '場所' : '記録の濃さ'}
          </button>
        ))}
      </div>

      {tab === 'summary' && (
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
      )}

      {tab === 'places' && (
        <ol className="places">
          {dataset.places.slice(0, 50).map((p) => (
            <li key={p.id}>
              <button className="places__row" onClick={() => onFocus(p.lon, p.lat)}>
                <span className="places__name">
                  {p.label ?? (p.semanticType !== 'UNKNOWN' ? p.semanticType : p.id.slice(0, 12))}
                </span>
                <span className="places__meta">
                  {nf.format(p.visitDays)} 日 / {hours(p.reliableSeconds)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {tab === 'coverage' && (
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
      )}

      <div className="panel__foot">
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
      </div>
    </div>
  )
}
