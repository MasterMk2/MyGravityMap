/**
 * 文字列をファイルとして端末に保存させる（ブラウザの「ダウンロード」）。
 *
 * サーバーを持たないアプリなので、Blob の object URL を一時的な <a download> に渡して
 * クリックさせる。データはブラウザの外へは出ない（保存先は利用者のディスク）。
 */
export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  // Firefox は文書に入っていない <a> の click() ではダウンロードしない
  document.body.appendChild(a)
  a.click()
  a.remove()
  // click() の直後に revoke すると、ダウンロードが URL を読み始める前に無効になる
  // ブラウザがある。少し待ってから解放する（数十 MB の Blob を持ち続けないため）。
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
