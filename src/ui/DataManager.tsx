/**
 * この端末に残っている解析結果の確認と削除。
 *
 * 解析結果には自宅や職場の座標が入っている。「データはこの端末から出ません」と
 * 言う以上、この端末からも確実に消せる手段を画面の中に用意しておく
 * （ブラウザのサイトデータ削除は、利用者が手順を知らないと辿り着けない）。
 */
import { useEffect, useState } from 'react'
import { clearAll, estimateUsage, listDatasets } from '../store/db'
import { useAppStore } from '../store/useAppStore'
import { useLabels } from '../store/labels'
import { usePlaceNames } from '../store/placeNames'

const nf = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 })

function mb(bytes: number): string {
  return `${nf.format(bytes / 1024 / 1024)} MB`
}

export function DataManager() {
  const reset = useAppStore((s) => s.reset)
  const [count, setCount] = useState<number | null>(null)
  const [usage, setUsage] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    listDatasets()
      .then((l) => alive && setCount(l.length))
      .catch(() => alive && setCount(null))
    estimateUsage()
      .then((u) => alive && setUsage(u?.usageBytes ?? null))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const onClear = async () => {
    const ok = window.confirm(
      'この端末に保存した解析結果・場所のラベル・地名・表示設定をすべて削除します。元に戻せません。よろしいですか？\n' +
        '（元の location-history.json には触れません）',
    )
    if (!ok) return
    setBusy(true)
    try {
      await clearAll()
      // メモリ上のラベルも消す（残っていると、消したはずの名前が画面に出続ける）
      useLabels.setState({ labels: {} })
      usePlaceNames.setState({ names: {} })
      reset()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="datamgr">
      <p className="datamgr__line">
        この端末に保存中: 解析結果 {count ?? '—'} 件
        {usage !== null && <>（サイト全体で約 {mb(usage)}）</>}
      </p>
      <button type="button" className="datamgr__clear" onClick={onClear} disabled={busy}>
        保存データをすべて消す
      </button>
    </div>
  )
}
