/**
 * ベースマップのレジストリ。API キーは一切使わない。
 * 到達性はブラウザから実測して確認済み（すべて HTTP 200）。
 * 'none' はオフライン用のインラインスタイルで、ソースを持たないため
 * タイルリクエストを一切発行しない。
 */
import type { StyleSpecification } from 'maplibre-gl'

export type BasemapId =
  | 'dark'
  | 'darkNoLabels'
  | 'eclipse'
  | 'ofmDark'
  | 'voyager'
  | 'liberty'
  | 'light'
  | 'lightNoLabels'
  | 'darkRaster'
  | 'none'

export interface Basemap {
  id: BasemapId
  /** UI に出す名前 */
  label: string
  /** 補足（ツールチップ） */
  hint: string
  /** 暗い地図か。軌跡の色を決めるときの参考にする */
  dark: boolean
  style: string | StyleSpecification
  attribution: string
}

const OSM = '© OpenStreetMap contributors'
const CARTO = `${OSM} © CARTO`
const OFM = `${OSM} © OpenFreeMap`
const VERSATILES = `${OSM} © VersaTiles`

/**
 * オフライン／ゼロネットワークのスタイル。
 * sources が空なので、選択してもタイルリクエストは一切発生しない。
 */
const NONE_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0a0a0a' } }],
}

/**
 * ラスタ版のダーク。
 * ベクタタイルは MapLibre の Worker が解析するが、ラスタタイルは
 * メインスレッドが画像として読むだけで Worker を通らない。
 * Worker まわりで問題が起きたときの保険として残してある。
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
      attribution: CARTO,
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
    label: 'ダーク',
    hint: 'CARTO Dark Matter（地名あり）',
    dark: true,
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    attribution: CARTO,
  },
  darkNoLabels: {
    id: 'darkNoLabels',
    label: 'ダーク（地名なし）',
    hint: '文字が消えるので軌跡がいちばん映える',
    dark: true,
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json',
    attribution: CARTO,
  },
  eclipse: {
    id: 'eclipse',
    label: 'エクリプス',
    hint: 'VersaTiles Eclipse（落ち着いた濃紺系）',
    dark: true,
    style: 'https://tiles.versatiles.org/assets/styles/eclipse/style.json',
    attribution: VERSATILES,
  },
  ofmDark: {
    id: 'ofmDark',
    label: 'OFM ダーク',
    hint: 'OpenFreeMap Dark（描き込み多め）',
    dark: true,
    style: 'https://tiles.openfreemap.org/styles/dark',
    attribution: OFM,
  },
  voyager: {
    id: 'voyager',
    label: 'ボイジャー',
    hint: 'CARTO Voyager（明るくカラフル）',
    dark: false,
    style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
    attribution: CARTO,
  },
  liberty: {
    id: 'liberty',
    label: 'リバティ',
    hint: 'OpenFreeMap Liberty（詳細な地形と建物）',
    dark: false,
    style: 'https://tiles.openfreemap.org/styles/liberty',
    attribution: OFM,
  },
  light: {
    id: 'light',
    label: 'ライト',
    hint: 'CARTO Positron（地名あり）',
    dark: false,
    style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    attribution: CARTO,
  },
  lightNoLabels: {
    id: 'lightNoLabels',
    label: 'ライト（地名なし）',
    hint: 'CARTO Positron ラベルなし',
    dark: false,
    style: 'https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json',
    attribution: CARTO,
  },
  darkRaster: {
    id: 'darkRaster',
    label: 'ダーク（ラスタ）',
    hint: 'Worker を使わないラスタ版。保険',
    dark: true,
    style: DARK_RASTER_STYLE,
    attribution: CARTO,
  },
  none: {
    id: 'none',
    label: 'なし',
    hint: '地図タイルを取得しない（通信ゼロ）',
    dark: true,
    style: NONE_STYLE,
    attribution: '',
  },
}

export const BASEMAP_ORDER: BasemapId[] = [
  'dark',
  'darkNoLabels',
  'eclipse',
  'ofmDark',
  'voyager',
  'liberty',
  'light',
  'lightNoLabels',
  'darkRaster',
  'none',
]

/** 後方互換: 以前は固定文字列だった */
export const ATTRIBUTION = CARTO

export function attributionOf(id: BasemapId): string {
  return BASEMAPS[id].attribution
}
