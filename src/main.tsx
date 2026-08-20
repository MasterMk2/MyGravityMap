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

const root = document.getElementById('root')
if (!root) throw new Error('#root が見つかりません')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
