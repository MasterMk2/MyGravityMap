import { test, expect } from '@playwright/test'

test('unsupported WebGL2 presents recovery UI without map traffic or unhandled errors', async ({ page }) => {
  const errors: string[] = []
  const externalRequests: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('request', request => {
    const url = new URL(request.url())
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) externalRequests.push(url.origin)
  })
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (...args: Parameters<typeof getContext>) {
      if (String(args[0]).startsWith('webgl')) return null
      return getContext.apply(this, args)
    } as typeof getContext
  })
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('synthetic-recovery-marker', 'preserved'))
  const notice = page.getByRole('alert')
  await expect(notice).toContainText('WebGL2を利用できません')
  await expect(page.getByRole('button', { name: 'ファイルを選ぶ' })).toBeHidden()
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: '地図の初期化を再試行' }).click()
    await expect(notice).toContainText('WebGL2を利用できません')
  }
  await page.reload()
  await expect(notice).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('synthetic-recovery-marker'))).toBe('preserved')
  expect(errors).toEqual([])
  expect(externalRequests).toEqual([])
})
