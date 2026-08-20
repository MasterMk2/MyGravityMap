/**
 * ベースマップのレジストリ。API キーは一切使わない。
 * 'dark' / 'light' は CARTO の公開 GL スタイルを参照する（タイル取得にネットワークが必要）。
 * 'none' はオフライン用のインラインスタイルで、ソースを持たないためネットワークリクエストを一切発行しない。
 */
import type { StyleSpecification } from 'maplibre-gl'

export type BasemapId = 'dark' | 'light' | 'none'

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

export const BASEMAPS: Record<BasemapId, Basemap> = {
  dark: {
    id: 'dark',
    label: 'Dark',
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
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
