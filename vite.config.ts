import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// GitHub Pages で公開するときはリポジトリ名がパスに入るため base を差し替える。
// 例: BASE_PATH=/MyGravityMap/ npm run build
const base = process.env.BASE_PATH ?? '/'

export default defineConfig({
  base,
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
