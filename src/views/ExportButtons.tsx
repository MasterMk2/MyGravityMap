/**
 * 選んだ期間の場所・軌跡を GeoJSON で書き出す（DESIGN.md §7 P3）。
 *
 * 押したときにだけ組み立てて端末に保存する。軌跡は全期間だと数十 MB になるので、
 * 描画のたびに作ったりはしない。送信はしない（DESIGN.md §9 の 1）。
 */
import { useEffect, useState } from 'react'
import type { Dataset, TimeWindow } from '../core/types'
import { rankPlaces } from '../core/ranking'
import { placesToGeoJSON, tripsToGeoJSON } from '../core/exportGeo'
import { localDayKey } from '../core/geo'
import { createTzLookup } from '../core/timezone'
import { useLabels } from '../store/labels'
import { downloadText } from '../ui/download'
import './PlacesView.css'

interface Props {
  dataset: Dataset
  selection: TimeWindow
}

const GEOJSON_MIME = 'application/geo+json'
const nf = new Intl.NumberFormat('ja-JP')

/**
 * ファイル名の期間部分。暦日は記録側の TZ で数える（ブラウザの TZ や UTC だと、
 * 画面の期間表示と 1 日ずれたファイル名になることがある）。
 */
function rangeLabel(dataset: Dataset, w: TimeWindow): string {
  const tz = createTzLookup(dataset.tzChanges)
  return `${localDayKey(w.start, tz(w.start))}_${localDayKey(w.end, tz(w.end))}`
}

export function ExportButtons({ dataset, selection }: Props) {
  const load = useLabels((s) => s.load)
  useEffect(() => {
    void load()
  }, [load])
  const [status, setStatus] = useState<string | null>(null)

  const exportPlaces = async () => {
    // ラベルの読み込みが終わる前に押されたら、名前の無いファイルにならないよう待つ
    if (!useLabels.getState().loaded) await load()
    // 書き出しは一覧の上位だけでなく期間内の全部。並びは既定の「日数」
    const places = rankPlaces(dataset.visits, selection, 'days')
    if (places.length === 0) {
      setStatus('この期間には書き出す場所がありません')
      return
    }
    const fc = placesToGeoJSON(places, useLabels.getState().labels, dataset.anchors)
    downloadText(
      `mygravitymap-places-${rangeLabel(dataset, selection)}.geojson`,
      JSON.stringify(fc),
      GEOJSON_MIME,
    )
    setStatus(`${nf.format(places.length)} か所を書き出しました`)
  }

  const exportTrips = () => {
    const fc = tripsToGeoJSON(dataset.trips, selection)
    if (fc.features.length === 0) {
      setStatus('この期間には書き出す軌跡がありません')
      return
    }
    downloadText(
      `mygravitymap-trips-${rangeLabel(dataset, selection)}.geojson`,
      JSON.stringify(fc),
      GEOJSON_MIME,
    )
    setStatus(`${nf.format(fc.features.length)} 本の軌跡を書き出しました`)
  }

  return (
    <div className="exportGeo">
      <div className="exportGeo__buttons">
        <button onClick={() => void exportPlaces()} title="選んだ期間の場所を GeoJSON で保存">
          場所を GeoJSON
        </button>
        <button onClick={exportTrips} title="選んだ期間の軌跡を GeoJSON で保存">
          軌跡を GeoJSON
        </button>
      </div>
      <p className="warn">書き出したファイルには自宅などの座標が含まれます。共有に注意</p>
      {/* 読み上げが確実に届くよう、中身が空でも要素は置いておく */}
      <p role="status">{status}</p>
    </div>
  )
}
