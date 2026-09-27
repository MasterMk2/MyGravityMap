import { useMemo, useState } from 'react'
import type { Dataset } from '../core/types'
import {
  bearingDeg,
  compassJa,
  DEFAULT_OUTLIER_KM,
  yearlyBarycenters,
  type YearBarycenter,
} from '../core/barycenter'
import { coverageYearRange, yearColor } from './barycenterLayers'
import './views-geo.css'

interface Props {
  dataset: Dataset
  showOnMap: boolean
  onShowOnMapChange: (v: boolean) => void
  onFocus: (lon: number, lat: number, zoom?: number) => void
  /**
   * App 側で yearlyBarycenters(dataset) を useMemo 済みならそれを渡す。
   * 地図のレイヤと表が同じ計算結果を見るようにするため。省略するとここで計算する。
   */
  stats?: YearBarycenter[]
  /** 強調する年（地図のレイヤと揃えたいときに App 側で持つ）。省略するとビューの中で持つ */
  selectedYear?: number | null
  onSelectYear?: (year: number | null) => void
}

const nf = new Intl.NumberFormat('ja-JP')

/** この日数に満たない年は記録が少なく、重心も半径も揺れやすい */
const FEW_DAYS = 30

function km(v: number): string {
  return v < 10 ? v.toFixed(1) : nf.format(Math.round(v))
}

function percent(share: number): string {
  const v = share * 100
  return v < 10 ? v.toFixed(1) : String(Math.round(v))
}

/**
 * 行動半径の円（直径）が地図のおよそ 300px に収まるズーム。
 * 1 画素あたりのメートル数は 156543 × cos(緯度) ÷ 2^ズーム。
 */
function zoomForRadius(radiusKm: number, lat: number): number {
  const meters = Math.max(0.5, radiusKm) * 1000
  const z = Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180) * 150) / meters)
  return Math.min(14, Math.max(3, z))
}

function rgbCss(c: [number, number, number]): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

export function BarycenterView({
  dataset,
  showOnMap,
  onShowOnMapChange,
  onFocus,
  stats: given,
  selectedYear,
  onSelectYear,
}: Props) {
  const computed = useMemo(() => (given ? null : yearlyBarycenters(dataset)), [given, dataset])
  const stats = given ?? computed ?? []
  const { minYear, maxYear } = useMemo(() => coverageYearRange(dataset), [dataset])
  const [localSelected, setLocalSelected] = useState<number | null>(null)
  const selected = selectedYear !== undefined ? selectedYear : localSelected
  const select = onSelectYear ?? setLocalSelected

  const pick = (s: YearBarycenter) => {
    if (s.year === selected) {
      select(null)
      return
    }
    select(s.year)
    // 年を選んだのに地図に何も出ていないと、飛んだ先で何を見ればよいか分からない
    if (!showOnMap) onShowOnMapChange(true)
    onFocus(s.lon, s.lat, zoomForRadius(s.radiusKm, s.lat))
  }

  if (stats.length === 0) {
    return (
      <div className="geo-view">
        <p className="geo-note">重心を計算できる軌跡がありません。</p>
      </div>
    )
  }

  return (
    <div className="geo-view">
      <label className="geo-toggle">
        <input
          type="checkbox"
          checked={showOnMap}
          onChange={(e) => onShowOnMapChange(e.target.checked)}
        />
        地図に表示
      </label>

      <p className="geo-note">
        重心＝その年の生活圏の中心（自宅から {DEFAULT_OUTLIER_KM} km を超える遠出は除外）。行動半径＝重心からの回転半径（RMS
        距離）。滞在時間ではなく「その場所に居た日数」で数えるので、記録の濃さが違う年どうしでも比べられます。
      </p>

      <table className="coverage geo-table">
        <thead>
          <tr>
            <th>年</th>
            <th>日数</th>
            <th>行動半径 km</th>
            <th>遠出 %</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr
              key={s.year}
              className={s.year === selected ? 'is-active' : ''}
              tabIndex={0}
              aria-selected={s.year === selected}
              title="クリックでこの年の重心へ移動（もう一度押すと強調を解除）"
              onClick={() => pick(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  pick(s)
                }
              }}
            >
              <td>
                <span
                  className="geo-swatch"
                  style={{ background: rgbCss(yearColor(s.year, minYear, maxYear)) }}
                />
                {s.year}
              </td>
              <td>
                {s.days < FEW_DAYS ? (
                  <span className="warn" title="記録が少ない年は参考値">
                    {s.days}
                  </span>
                ) : (
                  s.days
                )}
              </td>
              <td>{km(s.radiusKm)}</td>
              <td>{percent(s.awayShare)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {stats.length > 1 && (
        <>
          <h4 className="geo-heading">重心の移動</h4>
          <ul className="geo-shifts">
            {stats.slice(1).map((s, i) => {
              const prev = stats[i]!
              const d = s.shiftKm ?? 0
              return (
                <li key={s.year}>
                  <span>
                    {prev.year}→{s.year}
                  </span>
                  <span>
                    {d < 0.5 ? 'ほぼ同じ' : `${km(d)} km ${compassJa(bearingDeg(prev, s))}へ`}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      )}

      <p className="geo-note">
        2024 年より前は 1 日の記録が 6 時間ほどしか無く、動いたときしか残りません。日数の少ない年（
        <span className="warn">黄色</span>）の値は揺れやすい参考値です。
      </p>
    </div>
  )
}
