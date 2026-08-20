import type { GravityMode, GravitySettings } from '../gravity/layers'
import type { GravitySource, WeightedPoints } from '../gravity/weights'

interface Props {
  settings: GravitySettings
  onChange: (patch: Partial<GravitySettings>) => void
  points: WeightedPoints
  /** 選択中の期間に Google の訪問データがあるか。無ければ「滞在」を選ばせない */
  visitAvailable: boolean
}

const MODES: Array<{ value: GravityMode; label: string; hint: string }> = [
  { value: 'off', label: 'オフ', hint: '重力マップを表示しない' },
  { value: 'heat', label: 'ヒート', hint: '滞在時間の多い場所を色の濃さで示す' },
  { value: 'hex', label: '六角柱', hint: '滞在時間を柱の高さで示す（3D）' },
  { value: 'both', label: '両方', hint: 'ヒートマップの上に柱を重ねる' },
]

const SOURCES: Array<{ value: GravitySource; label: string; hint: string }> = [
  {
    value: 'track',
    label: '軌跡',
    hint: '全期間で使える。点の間隔から滞在時間を推定するので粗い',
  },
  {
    value: 'visit',
    label: '滞在',
    hint: 'Google の訪問データ。正確だが 2024 年秋以降しか存在しない',
  },
]

const RADII = [100, 250, 500, 1000]

const nf = new Intl.NumberFormat('ja-JP')

function hours(sec: number): string {
  const h = sec / 3600
  return h >= 10000 ? `${(h / 10000).toFixed(1)} 万時間` : `${nf.format(Math.round(h))} 時間`
}

export function GravityControls({ settings, onChange, points, visitAvailable }: Props) {
  const on = settings.mode !== 'off'

  return (
    <div className="gravity">
      <span className="gravity__label">重力マップ</span>
      <div className="segmented" role="group" aria-label="重力マップの表示">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            title={m.hint}
            className={settings.mode === m.value ? 'is-active' : ''}
            aria-pressed={settings.mode === m.value}
            onClick={() => onChange({ mode: m.value })}
          >
            {m.label}
          </button>
        ))}
      </div>

      {on && (
        <>
          <div className="gravity__row">
            <span>元データ</span>
            <div className="segmented" role="group" aria-label="重力マップの元データ">
              {SOURCES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  title={s.hint}
                  disabled={s.value === 'visit' && !visitAvailable}
                  className={settings.source === s.value ? 'is-active' : ''}
                  aria-pressed={settings.source === s.value}
                  onClick={() => onChange({ source: s.value })}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* 粒度は六角柱の 1 マスの大きさであり、ヒートマップの格子の大きさでもある */}
          <div className="gravity__row">
            <span>粒度</span>
            <div className="segmented" role="group" aria-label="粒度">
              {RADII.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={settings.radiusMeters === r ? 'is-active' : ''}
                  aria-pressed={settings.radiusMeters === r}
                  onClick={() => onChange({ radiusMeters: r })}
                >
                  {r >= 1000 ? `${r / 1000}km` : `${r}m`}
                </button>
              ))}
            </div>
          </div>

          <label className="gravity__slider">
            <span>
              強さ <em>{settings.intensity.toFixed(1)}</em>
            </span>
            <input
              type="range"
              min={0.5}
              max={8}
              step={0.5}
              value={settings.intensity}
              onChange={(e) => onChange({ intensity: Number(e.target.value) })}
              aria-label="重力マップの強さ"
            />
          </label>

          <p className="gravity__stat">
            {nf.format(points.count)} 点 / 合計 {hours(points.totalSeconds)}
            {settings.source === 'track' && (
              <span className="gravity__note">
                軌跡からの推定。年により記録の濃さが違うので、年をまたぐ比較には向きません
              </span>
            )}
            {settings.source === 'visit' && (
              <span className="gravity__note">
                Google の訪問データ。2024 年秋以降のみ
              </span>
            )}
          </p>
        </>
      )}
    </div>
  )
}
