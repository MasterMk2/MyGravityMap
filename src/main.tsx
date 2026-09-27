import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'

// 開発時のみ: 起動中の例外はコンソール表示が省略されて原因が追えないことがあるので、
// スタックをそのまま溜めておく（window.__errs で読む）。
if (import.meta.env.DEV) {
  const errs: string[] = []
  ;(window as unknown as { __errs: string[] }).__errs = errs
  window.addEventListener('error', (e) => errs.push(e.error?.stack ?? e.message))

  // deck.gl は描画時の問題を console.warn で知らせる（例外にはならない）。
  // 「エラーは出ていないのに描かれない」を追えるよう、警告も溜めておく。
  const warns: string[] = []
  ;(window as unknown as { __warns: string[] }).__warns = warns
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      warns.push(`[${level}] ${args.map((a) => String(a)).join(' ')}`.slice(0, 400))
      original(...args)
    }
  }
}

// 本番だけ Service Worker を入れる（一度開けばオフラインでも起動できるように）。
// 開発時に入れると、HMR の更新より古いキャッシュが勝って混乱する。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js?v=${__BUILD_ID__}`, { scope: import.meta.env.BASE_URL })
      .catch(() => {
        // 登録できなくてもアプリ自体は動く（オフラインで開けないだけ）
      })
  })
}

const root = document.getElementById('root')
if (!root) throw new Error('#root が見つかりません')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
