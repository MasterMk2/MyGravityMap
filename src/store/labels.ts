/**
 * 場所ラベル（利用者が付けた名前）の状態。IndexedDB の labels ストアと同期する。
 *
 * キーは Place.id（Google の placeId、無ければ 'grid:<緯度>:<経度>'）。どちらも
 * 同じファイルを解析し直しても変わらないので、キャッシュを捨てて再解析してもラベルは残る。
 * ラベルは端末のブラウザにだけ保存し、どこにも送らない（DESIGN.md §8 A / §9）。
 */
import { create } from 'zustand'
import { deleteLabel, getAllLabels, setLabel as saveLabel } from './db'

interface LabelsState {
  labels: Record<string, string>
  loaded: boolean
  /** 最後に失敗した読み書きの理由。プライベートブラウズ等で IndexedDB が使えないときに出る */
  error: string | null
  /** IndexedDB から読み込む。何度呼んでも読み込みは 1 回だけ */
  load: () => Promise<void>
  /** 空白だけのラベルは削除として扱う（＝自動ラベルの表示に戻す） */
  setLabel: (id: string, label: string) => Promise<void>
}

let loading: Promise<void> | undefined
/**
 * 読み込みが終わる前に編集された id。読み込み結果で上書きすると、
 * 「消したラベルが読み込み完了と同時に復活する」ことになるので、これらは手元の値を優先する。
 */
const touchedBeforeLoad = new Set<string>()

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const useLabels = create<LabelsState>((set, get) => ({
  labels: {},
  loaded: false,
  error: null,

  load: () => {
    loading ??= (async () => {
      try {
        const stored = await getAllLabels()
        const current = get().labels
        for (const id of touchedBeforeLoad) {
          if (id in current) stored[id] = current[id]!
          else delete stored[id]
        }
        set({ labels: stored, loaded: true })
      } catch (err) {
        // 読めなくても一覧は自動ラベルで出せるので、読み込み済みにして先へ進める
        set({ loaded: true, error: message(err) })
      } finally {
        touchedBeforeLoad.clear()
      }
    })()
    return loading
  },

  setLabel: async (id, label) => {
    const trimmed = label.trim()
    const prev = get().labels[id]
    if ((prev ?? '') === trimmed) return

    // 楽観的に先に画面へ反映する（IndexedDB の書き込みを待つと入力確定が一拍遅れて見える）
    const next = { ...get().labels }
    if (trimmed) next[id] = trimmed
    else delete next[id]
    if (!get().loaded) touchedBeforeLoad.add(id)
    set({ labels: next, error: null })

    try {
      if (trimmed) await saveLabel(id, trimmed)
      else await deleteLabel(id)
    } catch (err) {
      // 保存できなかったら画面も元に戻す。表示だけ変わって次回消えている、が一番困る。
      // ただし、その間に同じ場所を編集し直していたら新しい方を残す
      const reverted = { ...get().labels }
      if (reverted[id] === (trimmed || undefined)) {
        if (prev === undefined) delete reverted[id]
        else reverted[id] = prev
      }
      set({ labels: reverted, error: message(err) })
    }
  },
}))
