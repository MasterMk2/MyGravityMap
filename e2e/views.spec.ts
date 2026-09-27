import { test, expect, type Page } from '@playwright/test'

/**
 * デモデータ（架空の人物の合成データ）で、パネルの各タブと書き出しが実際に配線されているかを見る。
 * 実データ（Sampledata/）を使わないので、誰の手元でも同じように回せる。
 *
 * 数値の正しさは tests/ の単体テストが見ている。ここで捕まえたいのは
 * 「props の渡し忘れで押しても何も起きない」「描画時に例外で落ちる」といった配線の問題。
 */

function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    // 地図タイルの取得失敗（オフライン環境など）はアプリの不具合ではないので数えない
    if (/tile|Failed to load resource|net::ERR/i.test(msg.text())) return
    errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))
  return errors
}

test('デモデータで全タブが開き、例外が出ない', async ({ page }) => {
  const errors = collectErrors(page)
  await page.goto('/?demo')

  const tabs = page.getByRole('tablist', { name: 'パネルの表示内容' })
  await expect(tabs).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText('デモ', { exact: true })).toBeVisible()

  for (const name of ['場所', '統計', 'カレンダー', '遠征', '重心', '概要', '表示']) {
    await page.getByRole('tab', { name }).click()
    await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tabpanel')).not.toBeEmpty()
  }

  // 場所: 期間内の場所が数えられている
  await page.getByRole('tab', { name: '場所' }).click()
  await expect(page.getByText(/期間内 [\d,]+ か所/)).toBeVisible()

  // 遠征: 1 件以上抽出され、押すと再生の期間が変わる
  await page.getByRole('tab', { name: '遠征' }).click()
  const clockBefore = await page.locator('.playbackbar__periodDate').first().textContent()
  await page.locator('button.exped-row').first().click()
  await expect(page.locator('.playbackbar__periodDate').first()).not.toHaveText(clockBefore ?? '')

  // 重心: 地図に表示を切り替えられる
  await page.getByRole('tab', { name: '重心' }).click()
  await page.getByText('地図に表示').click()

  expect(errors).toEqual([])
})

test('重力マップを出し、PNG と GeoJSON を書き出せる', async ({ page }) => {
  const errors = collectErrors(page)
  await page.goto('/?demo')
  await expect(page.getByRole('tablist', { name: 'パネルの表示内容' })).toBeVisible({ timeout: 90_000 })

  // 既定の元データは「日数」
  await page.getByRole('button', { name: 'ヒート' }).click()
  await expect(page.getByText(/マス \/ 延べ [\d,]+ 日/)).toBeVisible()

  const png = page.waitForEvent('download')
  await page.getByRole('button', { name: '画像（PNG）' }).click()
  expect((await png).suggestedFilename()).toMatch(/\.png$/)

  const geo = page.waitForEvent('download')
  await page.getByRole('button', { name: /場所を GeoJSON/ }).click()
  expect((await geo).suggestedFilename()).toMatch(/\.geojson$/)

  expect(errors).toEqual([])
})
