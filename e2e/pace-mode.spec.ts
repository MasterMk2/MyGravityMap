import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * 「ペース」トグル（時間 / 動き）の配線を、実データを読み込んだ本物のブラウザで確認する。
 * core/playback.ts の distance-paced ロジック自体は tests/playback.test.ts が純粋関数として
 * 検証済み。ここで見たいのはそれとは別軸の話 — PlaybackBar の新しいボタンが実際に
 * usePlayback の changePace/settings に配線されていて、モード切替でUIが正しく
 * 出し分けられるか（props の渡し忘れなどはユニットテストでは検出できない）。
 *
 * Sampledata/location-history.json は取り込みに数十秒かかる（IndexedDB キャッシュが
 * 無い初回パースのため）ので、待ち受けのタイムアウトを長めに取っている。
 */
const SAMPLE_DATA = path.resolve(__dirname, '../Sampledata/location-history.json')

test('pace toggle switches the speed control and hides skipGaps in motion mode', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')

  // ファイルドロップの隠し input に実データを流し込み、取り込み完了（再生バー表示）を待つ
  await page.locator('input[type="file"]').setInputFiles(SAMPLE_DATA)

  const paceGroup = page.getByRole('group', { name: '再生ペース' })
  await expect(paceGroup).toBeVisible({ timeout: 150_000 })

  const timeButton = paceGroup.getByRole('button', { name: '時間' })
  const motionButton = paceGroup.getByRole('button', { name: '動き' })
  await expect(timeButton).toHaveAttribute('aria-pressed', 'true') // 既定は 'time'
  await expect(motionButton).toHaveAttribute('aria-pressed', 'false')

  const skipGapsToggle = page.getByRole('switch', { name: '空白スキップ' })
  await expect(skipGapsToggle).toBeVisible()

  // 時間モードでは「速度」ラベル・1分/秒などの候補が出ている
  await expect(page.getByRole('group', { name: '再生速度' })).toBeVisible()

  await motionButton.click()

  await expect(motionButton).toHaveAttribute('aria-pressed', 'true')
  await expect(timeButton).toHaveAttribute('aria-pressed', 'false')

  // 動きモードでは「速さ」ラベルに切り替わり、×0.5〜×4 の相対倍率になる
  const rateGroup = page.getByRole('group', { name: '再生の速さ' })
  await expect(rateGroup).toBeVisible()
  await expect(rateGroup.getByRole('button', { name: '×1' })).toHaveAttribute('aria-pressed', 'true')

  // 動きモードには「空白スキップ」の代替動作が無いので非表示になる
  await expect(skipGapsToggle).toBeHidden()

  await timeButton.click()

  await expect(timeButton).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('group', { name: '再生速度' })).toBeVisible()
  await expect(skipGapsToggle).toBeVisible()

  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([])
})
