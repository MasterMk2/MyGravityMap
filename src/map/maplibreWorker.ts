/**
 * MapLibre のベクタタイル解析 Worker を、Vite にバンドルさせた URL から読ませる。
 *
 * 既定では MapLibre は
 *   new URL('./maplibre-gl-worker.mjs', import.meta.url)
 * で Worker を探す。この相対解決はバンドラを通すと壊れる:
 *
 * - dev: 事前バンドルされると基準が node_modules/.vite/deps/ になり 404
 *   （vite.config.ts の optimizeDeps.exclude で回避してある）
 * - build: バンドル後の基準が dist/assets/ になるが、Vite は
 *   この Worker ファイルを成果物として出力しないので 404
 *
 * しかも MapLibre はこの失敗で error イベントを出さない。
 * 「エラーは何も出ないのにベクタタイルだけ永久に来ない」という、
 * 原因の分からない不具合になる（ラスタタイルは Worker を通らないので出てしまう）。
 *
 * Worker 本体は共有チャンクを相対 import しているため、ファイルを単純にコピーする
 * `?url` では動かない。`?worker&url` で Vite にバンドルさせた URL を渡す。
 */
import { setWorkerUrl } from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

let applied = false

export function ensureMaplibreWorker(): void {
  if (applied) return
  applied = true
  setWorkerUrl(maplibreWorkerUrl)
}
