/**
 * ライセンスとプライバシーの表示。
 * 公開してホストする以上、初めて来た人が「これは何をするものか」「自分のデータは
 * どこへ行くのか」を、ファイルを選ぶ前に読めるようにしておく必要がある。
 */
import licenseText from '../../LICENSE?raw'
import noticesUrl from '../../THIRD-PARTY-NOTICES.md?url'

export function PrivacyNote() {
  return (
    <div className="privacy">
      <strong className="privacy__title">データはこの端末から出ません</strong>
      <ul className="privacy__list">
        <li>
          選んだファイルは<b>ブラウザの中だけ</b>で解析します。サーバーへの送信も保存もしません。
        </li>
        <li>
          解析結果はこの端末のブラウザ内（IndexedDB）にのみ残ります。
          消したいときはブラウザのサイトデータを削除してください。
        </li>
        <li>
          Wi-Fi の MAC アドレスを含む <code>rawSignals</code> は、
          読み込む段階で件数を数えるだけで破棄します。保持しません。
        </li>
        <li>
          外部へ出る通信は<b>地図タイルの取得だけ</b>です。地図を「なし」にすれば、
          それもゼロになります。
        </li>
        <li>アクセス解析やエラー収集の類は入れていません。</li>
      </ul>
    </div>
  )
}

export function HowToExport() {
  return (
    <details className="howto">
      <summary>タイムラインの取り出し方</summary>
      <div className="howto__body">
        <p>
          タイムラインは端末内に保存されているため、Google マップアプリから書き出します。
          表記はアプリのバージョンによって少し違います。
        </p>
        <ol>
          <li>
            Google マップアプリを開き、右上の<b>プロフィール写真</b>をタップ
          </li>
          <li>
            <b>タイムライン</b>を開く
          </li>
          <li>
            右上の <b>⋮</b>（iPhone は <b>…</b>）から<b>設定</b>
          </li>
          <li>
            <b>タイムラインのエクスポート</b>を選び、保存
          </li>
          <li>保存した JSON をこのページに読み込ませる</li>
        </ol>
        <p className="howto__note">
          ファイル名は <code>location-history.json</code> または{' '}
          <code>タイムライン.json</code> で、数十 MB になることがあります。
          <br />
          Google データエクスポート（Takeout）の古い形式（<code>Records.json</code> や
          「セマンティック ロケーション履歴」フォルダ）にはまだ対応していません。
        </p>
      </div>
    </details>
  )
}

export function LicenseText() {
  return (
    <details className="howto">
      <summary>使用許諾条項</summary>
      <pre className="license-text">{licenseText}</pre>
    </details>
  )
}

export function LicenseLinks({ compact = false }: { compact?: boolean }) {
  return (
    <p className={`licenses${compact ? ' licenses--compact' : ''}`}>
      MyGravityMap © 2026 西野耀史 ·{' '}
      <a href={noticesUrl} target="_blank" rel="noreferrer">
        第三者ソフトウェア（286 件）
      </a>
      <br />
      地図データ © OpenStreetMap contributors（ODbL） · タイルは CARTO /
      OpenFreeMap / VersaTiles
    </p>
  )
}
