import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// GitHub Pages で公開するときはリポジトリ名がパスに入るため base を差し替える。
// 例: BASE_PATH=/MyGravityMap/ npm run build
const base = process.env.BASE_PATH ?? '/'

export default defineConfig({
  base,
  plugins: [react()],
  // ★ maplibre-gl を事前バンドルさせない。
  // maplibre はベクタタイル解析用の Worker を
  //   new URL('./maplibre-gl-worker.mjs', import.meta.url)
  // で読み込む。事前バンドルされると基準が node_modules/.vite/deps/ になり、
  // そこに Worker ファイルは無いので 404 になる。しかも maplibre は
  // この失敗で error イベントを出さないため、
  // 「エラーは何も出ないのにベクタタイルだけ永久に来ない」という状態になる。
  // （ラスタタイルは Worker を通らないので出てしまい、原因が分かりにくい）
  optimizeDeps: { exclude: ['maplibre-gl'] },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
