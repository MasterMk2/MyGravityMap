import type { MapStatus } from './mapSession'

export function MapStatusNotice({ status, onRetry }: { status: MapStatus; onRetry: () => void }) {
  if (status.phase === 'ready') return null
  if (status.phase === 'loading') return (
    <div className="mgm-map-status" role="status"><p>地図を準備中…</p></div>
  )
  const unsupported = status.reason === 'unsupported'
  return (
    <div className="mgm-map-status">
      <section className="mgm-map-status__card" role="alert" aria-labelledby="map-failure-title">
        <h1 id="map-failure-title">{unsupported ? 'このブラウザーでは地図を表示できません' : '地図の表示を開始・継続できませんでした'}</h1>
        <p>{unsupported
          ? 'WebGL2を利用できません。WebGL2対応のブラウザーまたは端末で開いてください。'
          : '地図の初期化または描画中に問題が発生しました。再試行しても解決しない場合は、対応するブラウザーまたは端末で開いてください。'}</p>
        <p>地図の表示・再生・画像出力は現在利用できません。再試行しても読み込み済み・保存済みのデータは削除されません。</p>
        <button type="button" onClick={onRetry}>地図の初期化を再試行</button>
      </section>
    </div>
  )
}
