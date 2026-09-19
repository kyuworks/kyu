import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Unit lane reads the SDK (and the schemas it imports by package name) from source so no build step sits between an edit and a test run.
    alias: {
      '@kyuworks/sdk': path.resolve(import.meta.dirname, '../../packages/sdk/src/index.ts'),
      '@kyuworks/schemas': path.resolve(import.meta.dirname, '../../packages/schemas/src/index.ts'),
    },
  },
  test: {
    // web/lib's pure functions are plain .test.ts; only components need .test.tsx.
    include: ['src/**/*.test.ts', 'web/**/*.test.ts', 'web/**/*.test.tsx'],
    exclude: ['src/**/*.integration.test.ts'],
  },
})
