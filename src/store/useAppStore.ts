import { create } from 'zustand'
import type { Dataset, ParseMessage } from '../core/types'
import { PIPELINE_VERSION } from '../core/types'
import type { ParseSource } from '../workers/parse.worker'
import { DEMO_SEED, DEMO_VERSION } from '../demo/generate'
import { fileFingerprint, loadDataset, pruneStaleDatasets, saveDataset } from './db'

import { DEFAULT_TRIP_GAP_SEC, importCacheKey, validateTripGapSec } from '../core/importSettings'

const DEMO_HASH_PREFIX = 'demo:'

/**
 * デモの解析結果のキャッシュキー（Dataset.fileHash）。
 * 生成器の版とパイプラインの版を両方混ぜておき、どちらかが変われば作り直させる。
 */
export function demoFileHash(seed: number = DEMO_SEED, gapSec: number = DEFAULT_TRIP_GAP_SEC): string {
  return importCacheKey(`${DEMO_HASH_PREFIX}${seed}:v${DEMO_VERSION}`, gapSec, PIPELINE_VERSION)
}

/** 架空の人物のデモデータか。画面で「デモ」と明示するために使う（実在の人の記録と誤解させない） */
export function isDemoDataset(d: Pick<Dataset, 'fileHash'>): boolean {
  return d.fileHash.startsWith(DEMO_HASH_PREFIX)
}

export type Status = 'idle' | 'hashing' | 'parsing' | 'ready' | 'error'

interface AppState {
  tripGapSec: number
  setTripGapSec: (seconds: number) => void
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
  /** 架空の人物の合成データ（約 7 年分）を読み込む。自分のエクスポートが無い人向け */
  loadDemo: () => Promise<void>
  reset: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  tripGapSec: DEFAULT_TRIP_GAP_SEC,
  setTripGapSec: (seconds) => {
    if (get().status === 'hashing' || get().status === 'parsing') return
    set({ tripGapSec: validateTripGapSec(seconds) })
  },
  status: 'idle',
  phase: '',
  progress: 0,
  error: null,
  dataset: null,
  fromCache: false,

  reset: () =>
    set({ status: 'idle', phase: '', progress: 0, error: null, dataset: null, fromCache: false }),

  loadFile: async (file: File) => {
    if (get().status === 'hashing' || get().status === 'parsing') return
    set({ status: 'hashing', phase: 'ファイルを確認中', progress: 0, error: null })
    try {
      const gapSec = get().tripGapSec
      const fileHash = importCacheKey(await fileFingerprint(file), gapSec, PIPELINE_VERSION)
      await run({ kind: 'file', file }, fileHash, set, gapSec)
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },

  loadDevUrl: async (url: string) => {
    if (get().status === 'hashing' || get().status === 'parsing') return
    set({ status: 'hashing', phase: 'ファイルを確認中', progress: 0, error: null })
    try {
      const name = url.split('/').pop() ?? url
      const gapSec = get().tripGapSec
      await run({ kind: 'url', url, name }, importCacheKey(`dev:${url}`, gapSec, PIPELINE_VERSION), set, gapSec)
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },

  loadDemo: async () => {
    if (get().status === 'hashing' || get().status === 'parsing') return
    set({ status: 'hashing', phase: 'デモデータを準備中', progress: 0, error: null })
    try {
      const gapSec = get().tripGapSec
      await run({ kind: 'demo', seed: DEMO_SEED }, demoFileHash(DEMO_SEED, gapSec), set, gapSec)
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },
}))

type Setter = (partial: Partial<AppState>) => void

async function run(source: ParseSource, fileHash: string, set: Setter, tripGapSec: number) {
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
      worker.postMessage({ source, fileHash, tripGapSec })
    })

    await saveDataset(dataset)
    // 版が上がる前の解析結果は二度と読まれないので、ついでに片付ける（失敗しても表示には関係ない）
    void pruneStaleDatasets(`:p${PIPELINE_VERSION}`).catch(() => undefined)
    set({ status: 'ready', dataset, progress: 1, phase: '' })
  } finally {
    worker.terminate()
  }
}
