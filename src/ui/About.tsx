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
          タイムラインは端末内に保存されているので、端末から書き出します。
          <b>Android と iPhone で場所が違います。</b>
        </p>

        <p className="howto__platform">Android（端末の「設定」アプリから）</p>
        <ol>
          <li>
            端末の<b>設定</b>アプリを開く（Google マップではありません）
          </li>
          <li>
            <b>位置情報</b> → <b>位置情報サービス</b> → <b>タイムライン</b>
          </li>
          <li>
            <b>タイムライン データをエクスポート</b>をタップ
          </li>
        </ol>

        <p className="howto__platform">iPhone / iPad（Google マップアプリから）</p>
        <ol>
          <li>
            Google マップを開き、右上の<b>プロフィール写真</b> → <b>設定</b>
          </li>
          <li>
            <b>個人的なコンテンツ</b>を開く
          </li>
          <li>
            「位置情報の設定」の中の<b>タイムライン データをエクスポート</b>
          </li>
          <li>
            共有シートで<b>ファイルに保存</b>
          </li>
        </ol>

        <p className="howto__note">
          書き出されるファイルは <code>location-history.json</code>（JSON 形式）で、
          記録が長いと数十 MB になります。保存したらこのページに読み込ませてください。
          <br />
          手順は{' '}
          <a
            href="https://support.google.com/maps/answer/6258979?hl=ja"
            target="_blank"
            rel="noreferrer"
          >
            Google マップ ヘルプ
          </a>
          （2026 年 8 月時点）に基づいています。表記はバージョンによって変わることがあります。
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
