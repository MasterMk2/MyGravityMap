/**
 * ベースマップのレジストリ。API キーは一切使わない。
 * 'dark' / 'light' は CARTO の公開 GL スタイルを参照する（タイル取得にネットワークが必要）。
 * 'none' はオフライン用のインラインスタイルで、ソースを持たないためネットワークリクエストを一切発行しない。
 */
import type { StyleSpecification } from 'maplibre-gl'

export type BasemapId = 'dark' | 'darkRaster' | 'light' | 'none'

export interface Basemap {
  id: BasemapId
  label: string
  style: string | StyleSpecification
}

/**
 * オフライン／ゼロネットワークのスタイル。
 * sources が空なので、選択してもタイルリクエストは一切発生しない。
 * ほぼ黒に近い背景色のみを描画する。
 */
const NONE_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': '#0a0a0a',
      },
    },
  ],
}

/**
 * ラスタ版のダーク。
 * ベクタタイルは MapLibre の Worker が解析するが、ラスタタイルは
 * メインスレッドが画像として読むだけで Worker を通らない。
 * Worker が動かない環境でも地図が出る保険として用意している。
 */
const DARK_RASTER_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    cartoRaster: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0b0d12' } },
    { id: 'cartoRaster', type: 'raster', source: 'cartoRaster' },
  ],
}

export const BASEMAPS: Record<BasemapId, Basemap> = {
  dark: {
    id: 'dark',
    label: 'Dark',
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  },
  darkRaster: {
    id: 'darkRaster',
    label: 'Dark (raster)',
    style: DARK_RASTER_STYLE,
  },
  light: {
    id: 'light',
    label: 'Light',
    style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  },
  none: {
    id: 'none',
    label: 'None (offline)',
    style: NONE_STYLE,
  },
}

/** CARTO ベースマップ使用時に表示しなければならないアトリビューション文字列 */
export const ATTRIBUTION = '© OpenStreetMap contributors © CARTO'
