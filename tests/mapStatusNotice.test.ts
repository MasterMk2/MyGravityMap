import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MapStatusNotice } from '../src/map/MapStatusNotice'

describe('visible map status UI', () => {
  it('renders an accessible honest unsupported message and manual retry', () => {
    const html = renderToStaticMarkup(createElement(MapStatusNotice, { status: { phase: 'failed', reason: 'unsupported' }, onRetry: () => undefined }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('WebGL2を利用できません')
    expect(html).toContain('地図の初期化を再試行')
    expect(html).toContain('保存済みのデータは削除されません')
    expect(html).toContain('画像出力は現在利用できません')
  })
  it('shows generic initialization/render failures without leaking raw exception content', () => {
    for (const reason of ['initialization', 'rendering'] as const) {
      const html = renderToStaticMarkup(createElement(MapStatusNotice, { status: { phase: 'failed', reason }, onRetry: () => undefined }))
      expect(html).toContain('role="alert"')
      expect(html).toContain('問題が発生しました')
    }
  })
  it('announces loading and renders no failure notice on success', () => {
    const props = { onRetry: () => undefined }
    expect(renderToStaticMarkup(createElement(MapStatusNotice, { ...props, status: { phase: 'loading' } }))).toContain('role="status"')
    expect(renderToStaticMarkup(createElement(MapStatusNotice, { ...props, status: { phase: 'ready' } }))).toBe('')
  })
})
