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
}

const root = document.getElementById('root')
if (!root) throw new Error('#root が見つかりません')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
