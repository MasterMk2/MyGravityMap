/**
 * 3D建物を追加するための純粋関数。
 *
 * このプロジェクトの基図（CARTO / OpenFreeMap / VersaTiles）はすべて
 * OpenMapTiles スキーマのベクタタイルで、建物は source-layer "building"、
 * 高さは render_height / render_min_height プロパティを持つ（無ければ
 * height / min_height にフォールバック、それも無ければ既定値）。
 *
 * 新しいタイルサーバーやAPIキーは一切増やさない — 既存のベクタソースに
 * fill-extrusion レイヤを1枚足すだけ。地図インスタンスへの配線はこの
 * ファイルの範囲外で、純粋関数だけを提供する。
 */
import type { FillExtrusionLayerSpecification, StyleSpecification } from 'maplibre-gl'

/**
 * style.sources の中から `type: 'vector'` の最初のソースの id を返す。
 * ベクタソースが無ければ null。
 */
export function findVectorSourceId(style: StyleSpecification): string | null {
  const sources = style.sources
  if (!sources) return null
  for (const id of Object.keys(sources)) {
    const source = sources[id]
    if (source && source.type === 'vector') return id
  }
  return null
}

export interface BuildingsOptions {
  minzoom?: number
}

/**
 * ベクタソースに対して 3D建物を描く fill-extrusion レイヤ仕様を組み立てる。
 * ベクタソースが無い（ラスタ基図・オフライン基図など）場合は null を返す。
 */
export function buildBuildingsLayer(
  style: StyleSpecification,
  options?: BuildingsOptions,
): FillExtrusionLayerSpecification | null {
  const sourceId = findVectorSourceId(style)
  if (sourceId === null) return null

  const layer: FillExtrusionLayerSpecification = {
    id: 'buildings',
    type: 'fill-extrusion',
    source: sourceId,
    'source-layer': 'building',
    minzoom: options?.minzoom ?? 14,
    paint: {
      'fill-extrusion-height': [
        'coalesce',
        ['get', 'render_height'],
        ['get', 'height'],
        6,
      ],
      'fill-extrusion-base': [
        'coalesce',
        ['get', 'render_min_height'],
        ['get', 'min_height'],
        0,
      ],
    },
  }
  return layer
}
