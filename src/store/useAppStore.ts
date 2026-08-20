import { create } from 'zustand'
import type { Dataset, ParseMessage } from '../core/types'
import { PIPELINE_VERSION } from '../core/types'
import type { ParseSource } from '../workers/parse.worker'
import { fileFingerprint, loadDataset, saveDataset } from './db'

export type Status = 'idle' | 'hashing' | 'parsing' | 'ready' | 'error'

interface AppState {
  status: Status
  phase: string
  progress: number // 0..1
  error: string | null
  dataset: Dataset | null
  /** 解析済みキャッシュから復元したか */
  fromCache: boolean
  loadFile: (file: File) => Promise<void>
  /** 開発時のみ: dev サーバ経由でリポジトリ内のファイルを直接読む */
  loadDevUrl: (url: string) => Promise<void>
  reset: () => void
}

export const useAppStore = create<AppState>((set) => ({
  status: 'idle',
  phase: '',
  progress: 0,
  error: null,
  dataset: null,
  fromCache: false,

  reset: () =>
    set({ status: 'idle', phase: '', progress: 0, error: null, dataset: null, fromCache: false }),

  loadFile: async (file: File) => {
    set({ status: 'hashing', phase: 'ファイルを確認中', progress: 0, error: null })
    try {
      const fileHash = `${await fileFingerprint(file)}:p${PIPELINE_VERSION}`
      await run({ kind: 'file', file }, fileHash, set)
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },

  loadDevUrl: async (url: string) => {
    set({ status: 'hashing', phase: 'ファイルを確認中', progress: 0, error: null })
    try {
      const name = url.split('/').pop() ?? url
      await run({ kind: 'url', url, name }, `dev:${url}:p${PIPELINE_VERSION}`, set)
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },
}))

type Setter = (partial: Partial<AppState>) => void

async function run(source: ParseSource, fileHash: string, set: Setter) {
  // 同じファイルを一度解析していればそれを使う（74MB を読み直さない）
  const cached = await loadDataset(fileHash)
  if (cached) {
    set({ status: 'ready', dataset: cached, fromCache: true, progress: 1, phase: '' })
    return
  }

  set({ status: 'parsing', phase: '解析中', progress: 0, fromCache: false })

  const worker = new Worker(new URL('../workers/parse.worker.ts', import.meta.url), {
    type: 'module',
  })

  try {
    const dataset = await new Promise<Dataset>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<ParseMessage>) => {
        const m = ev.data
        if (m.type === 'progress') {
          set({ phase: m.phase, progress: m.bytesTotal ? m.bytesRead / m.bytesTotal : 0 })
        } else if (m.type === 'done') {
          resolve(m.dataset)
        } else {
          reject(new Error(m.message))
        }
      }
      worker.onerror = (e) => reject(new Error(e.message || 'Worker が異常終了しました'))
      worker.postMessage({ source, fileHash })
    })

    await saveDataset(dataset)
    set({ status: 'ready', dataset, progress: 1, phase: '' })
  } finally {
    worker.terminate()
  }
}
