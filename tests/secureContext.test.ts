// @vitest-environment node
/**
 * http: で配信されたページ（安全な接続ではない）では crypto はあっても crypto.subtle が無い。
 * そのとき JS の生のエラーではなく、HTTPS で開き直すよう案内することを確かめる。
 * 実際のブラウザーと同じ形（crypto はある・subtle だけ無い）を crypto の差し替えで作る。
 * 使うファイルは中身を持たない合成のもので、実際の位置履歴は使わない。
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canFingerprintFiles,
  fileFingerprint,
  INSECURE_CONTEXT_MESSAGE,
  InsecureContextError,
} from '../src/store/db'
import { useAppStore } from '../src/store/useAppStore'
import { FileDrop } from '../src/ui/FileDrop'

function stubInsecureContext() {
  const real = globalThis.crypto
  vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) })
}

function syntheticFile(): File {
  return new File(['{"semanticSegments":[]}'], 'synthetic.json', { type: 'application/json', lastModified: 0 })
}

const RAW_MESSAGE = 'crypto.subtle'
const PICK_BUTTON_DISABLED = /<button[^>]*disabled=""[^>]*>ファイルを選ぶ<\/button>/
const DEMO_BUTTON_DISABLED = /<button[^>]*disabled=""[^>]*>デモデータで試す<\/button>/

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.getState().reset()
})

describe('安全な接続ではないページでのファイル読み込み', () => {
  it('canFingerprintFiles は crypto.subtle が無いと false、あれば true', () => {
    expect(canFingerprintFiles()).toBe(true)
    stubInsecureContext()
    expect(globalThis.crypto).toBeDefined()
    expect(canFingerprintFiles()).toBe(false)
  })

  it('fileFingerprint は生のメッセージではなく HTTPS への案内を投げる', async () => {
    stubInsecureContext()
    const error = await fileFingerprint(syntheticFile()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InsecureContextError)
    const message = (error as Error).message
    expect(message).toBe(INSECURE_CONTEXT_MESSAGE)
    expect(message).toContain('HTTPS')
    expect(message).toContain('localhost')
    expect(message).not.toContain(RAW_MESSAGE)
  })

  it('それでも loadFile が呼ばれたら、案内文を error に入れて止まる', async () => {
    stubInsecureContext()
    await useAppStore.getState().loadFile(syntheticFile())
    const { status, error } = useAppStore.getState()
    expect(status).toBe('error')
    expect(error).toBe(INSECURE_CONTEXT_MESSAGE)
  })

  it('読み込み画面は選ぶ前に案内を出し、ファイル選択だけを止めてデモは残す', () => {
    stubInsecureContext()
    const html = renderToStaticMarkup(createElement(FileDrop))
    expect(html).toContain('role="alert"')
    expect(html).toContain(INSECURE_CONTEXT_MESSAGE)
    expect(html).toContain('デモデータは、このままでも試せます。')
    expect(html).toMatch(PICK_BUTTON_DISABLED)
    expect(html).toContain('デモデータで試す')
    expect(html).not.toMatch(DEMO_BUTTON_DISABLED)
    expect(html).not.toContain(RAW_MESSAGE)
  })

  it('安全な接続では案内を出さず、ファイルを選べる', () => {
    const html = renderToStaticMarkup(createElement(FileDrop))
    expect(html).not.toContain(INSECURE_CONTEXT_MESSAGE)
    expect(html).toContain('ファイルを選ぶ')
    expect(html).not.toMatch(PICK_BUTTON_DISABLED)
  })
})
