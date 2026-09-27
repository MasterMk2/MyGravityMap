/**
 * Nominatim から取った地名（DESIGN.md §8 A-2）。利用者のラベルとは別に持つ。
 *
 * - 問い合わせは利用者がボタンを押したときだけ。1 秒に 1 件まで（Nominatim の利用規約）。
 * - 結果は IndexedDB に残し、同じ場所は二度と問い合わせない（同じく規約でキャッシュが必須）。
 * - 件数を絞る。数百か所を一度に流すのは規約の「一括での逆ジオコーディング」に当たるので、
 *   1 回の操作で問い合わせるのは画面に出ている上位の場所だけにする。
 */
import { create } from 'zustand'
import type { Place } from '../core/types'
import { nameFromNominatim, reverseUrl, type NominatimReverse } from '../core/geocode'
import { getSetting, setSetting } from './db'

const SETTING_KEY = 'placeNames'
/** 問い合わせの間隔。規約の上限は 1 秒に 1 件なので、少し余裕を持たせる */
const INTERVAL_MS = 1100
/** 1 回の操作で問い合わせる最大件数 */
export const GEOCODE_BATCH = 20

interface PlaceNamesState {
  /** Place.id → 地名。見つからなかった場所は空文字（もう一度問い合わせないため） */
  names: Record<string, string>
  loaded: boolean
  /** 問い合わせ中なら [済んだ件数, 全件数] */
  progress: [number, number] | null
  error: string | null
  load: () => Promise<void>
  /** 地名がまだ無い場所を、上から GEOCODE_BATCH 件まで問い合わせる */
  resolve: (places: Place[]) => Promise<void>
  cancel: () => void
}

let loading: Promise<void> | undefined
let cancelled = false

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const usePlaceNames = create<PlaceNamesState>((set, get) => ({
  names: {},
  loaded: false,
  progress: null,
  error: null,

  load: () => {
    loading ??= getSetting<Record<string, string>>(SETTING_KEY, {})
      .then((names) => set({ names: { ...names, ...get().names }, loaded: true }))
      .catch(() => set({ loaded: true }))
    return loading
  },

  resolve: async (places) => {
    if (get().progress) return
    await get().load()
    const todo = places.filter((p) => !(p.id in get().names)).slice(0, GEOCODE_BATCH)
    if (todo.length === 0) return
    cancelled = false
    set({ progress: [0, todo.length], error: null })
    try {
      for (let i = 0; i < todo.length; i++) {
        if (cancelled) break
        const p = todo[i]!
        const started = Date.now()
        // Referer（このページのオリジン）で呼び出し元が分かる。ブラウザからは User-Agent を変えられない
        const res = await fetch(reverseUrl(p.lat, p.lon), { headers: { Accept: 'application/json' } })
        if (res.status === 429 || res.status === 403) {
          set({ error: '問い合わせが多すぎると断られました。時間をおいてから試してください' })
          break
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const name = nameFromNominatim((await res.json()) as NominatimReverse) ?? ''
        const names = { ...get().names, [p.id]: name }
        set({ names, progress: [i + 1, todo.length] })
        await setSetting(SETTING_KEY, names).catch(() => undefined)
        const wait = INTERVAL_MS - (Date.now() - started)
        if (i + 1 < todo.length && wait > 0) await sleep(wait)
      }
    } catch (err) {
      set({ error: `地名を取得できませんでした: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      set({ progress: null })
    }
  },

  cancel: () => {
    cancelled = true
  },
}))
