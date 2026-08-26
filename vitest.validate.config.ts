import { defineConfig } from 'vitest/config'

/**
 * 検証ハーネス専用の設定（`npm run validate:visits`）。
 *
 * ふつうのテストとは別にしてあるのは、
 * - 実データ（Sampledata/）が要る。CI にも他人の環境にも無い
 * - 数十秒かかるうえ、合否ではなく表を出すのが目的
 * ため。`npm test` の include（tests/**\/*.test.ts）には入らない名前にしてある。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.harness.ts'],
  },
})
