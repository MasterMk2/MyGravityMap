import { describe, it, expect } from 'vitest'
import type { StyleSpecification } from 'maplibre-gl'
import { findVectorSourceId, buildBuildingsLayer } from '../src/map/buildings'

/**
 * buildBuildingsLayer / findVectorSourceId の受け入れ基準
 * （ジョブ「3d-buildings-layer」のゲート）。
 *
 * このプロジェクトの基図（CARTO / OpenFreeMap / VersaTiles）はすべて OpenMapTiles
 * スキーマのベクタタイルで、建物は source-layer "building"、高さは render_height /
 * render_min_height プロパティを持つ（無ければ height / min_height にフォールバック、
 * それも無ければ既定値）。新しいタイルサーバーやAPIキーは一切増やさない —
 * 既存のベクタソースに fill-extrusion レイヤを1枚足すだけ。
 *
 * ラスタ基図（darkRaster）やオフライン基図（none）はベクタソースを持たないため、
 * その場合は null を返して「3D建物を追加できない」ことを表す。
 */

const VECTOR_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    openmaptiles: { type: 'vector', tiles: ['https://example.invalid/{z}/{x}/{y}.pbf'] },
  },
  layers: [],
}

const RASTER_ONLY_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    cartoRaster: {
      type: 'raster',
      tiles: ['https://example.invalid/{z}/{x}/{y}.png'],
      tileSize: 256,
    },
  },
  layers: [],
}

const NO_SOURCE_STYLE: StyleSpecification = { version: 8, sources: {}, layers: [] }

describe('findVectorSourceId', () => {
  it('returns the vector source id when one is present', () => {
    expect(findVectorSourceId(VECTOR_STYLE)).toBe('openmaptiles')
  })

  it('returns null when only raster sources exist', () => {
    expect(findVectorSourceId(RASTER_ONLY_STYLE)).toBeNull()
  })

  it('returns null when there are no sources at all', () => {
    expect(findVectorSourceId(NO_SOURCE_STYLE)).toBeNull()
  })
})

describe('buildBuildingsLayer', () => {
  it('returns null when the style has no vector source (raster or sourceless basemaps)', () => {
    expect(buildBuildingsLayer(RASTER_ONLY_STYLE)).toBeNull()
    expect(buildBuildingsLayer(NO_SOURCE_STYLE)).toBeNull()
  })

  it('builds a fill-extrusion layer against the OpenMapTiles building source-layer', () => {
    const layer = buildBuildingsLayer(VECTOR_STYLE)
    expect(layer).not.toBeNull()
    expect(layer?.type).toBe('fill-extrusion')
    expect(layer?.source).toBe('openmaptiles')
    expect((layer as Record<string, unknown>)['source-layer']).toBe('building')
    expect(layer?.minzoom).toBe(14)
  })

  it('prefers render_height/render_min_height, falling back to height/min_height, then a default', () => {
    const layer = buildBuildingsLayer(VECTOR_STYLE) as unknown as {
      paint: Record<string, unknown>
    }
    expect(layer.paint['fill-extrusion-height']).toEqual([
      'coalesce',
      ['get', 'render_height'],
      ['get', 'height'],
      6,
    ])
    expect(layer.paint['fill-extrusion-base']).toEqual([
      'coalesce',
      ['get', 'render_min_height'],
      ['get', 'min_height'],
      0,
    ])
  })

  it('respects a minzoom override', () => {
    const layer = buildBuildingsLayer(VECTOR_STYLE, { minzoom: 16 })
    expect(layer?.minzoom).toBe(16)
  })

  it('does not introduce a new source — it always reuses the id findVectorSourceId reports', () => {
    const layer = buildBuildingsLayer(VECTOR_STYLE)
    expect(layer?.source).toBe(findVectorSourceId(VECTOR_STYLE))
  })
})
