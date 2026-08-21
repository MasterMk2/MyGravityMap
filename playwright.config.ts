import { defineConfig, devices } from '@playwright/test'

/**
 * ブラウザ越しの実UIチェック用。ユニットテスト（tests/、vitest）とは別軸で、
 * 「実データを読み込んでコンポーネントが実際に配線されているか」だけを見る。
 * 網羅的な回帰スイートではなく、ユニットテストでは検証できない配線ミス
 * （props の渡し忘れなど）を捕まえるための少数の代表シナリオを置く。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
