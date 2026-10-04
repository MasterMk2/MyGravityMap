import { test, expect } from '@playwright/test'

test('import validation and playback/gravity controls use only synthetic data', async ({ page }) => {
  // No real coordinates, external geocoding or tile traffic are needed for preference UI checks.
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue()
    return route.abort()
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto('/')
  const gap = page.getByRole('spinbutton', { name: 'トリップ分割閾値（分）' })
  await expect(gap).toHaveValue('30')
  await gap.fill('0')
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: 'デモデータで試す' })).toBeDisabled()
  await gap.fill('10')
  await expect(page.getByRole('button', { name: 'デモデータで試す' })).toBeEnabled()
  const fixture = { semanticSegments: [{ startTime: '2025-01-01T00:00:00Z', endTime: '2025-01-01T01:00:00Z', timelinePath: [
    { point: '30°, 10°', time: '2025-01-01T00:00:00Z' },
    { point: '30.001°, 10.001°', time: '2025-01-01T00:15:00Z' },
    { point: '30.002°, 10.002°', time: '2025-01-01T00:30:00Z' },
  ] }] }
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) })
  await expect(page.getByRole('group', { name: '再生ペース' })).toBeVisible()
  const toggle = page.getByRole('button', { name: /表示の設定/ })
  const interpolation = page.getByRole('combobox', { name: '補間方式' })
  if (!(await interpolation.isVisible())) await toggle.click()
  await expect(interpolation).toHaveValue('linear')
  await interpolation.selectOption('none')
  await expect(interpolation).toHaveValue('none')
  await interpolation.selectOption('linear')
  await expect(interpolation).toHaveValue('linear')
  const heat = page.getByRole('group', { name: '重力マップの表示' }).getByRole('button', { name: 'ヒート', exact: true })
  await heat.click()
  const normalization = page.getByRole('combobox', { name: '年内正規化' })
  await expect(normalization).toHaveValue('year-percentile')
  await normalization.selectOption('raw')
  await expect(normalization).toHaveValue('raw')
  await normalization.selectOption('year-percentile')
  await expect(normalization).toHaveValue('year-percentile')
  expect(errors).toEqual([])
})
