import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Unit lane reads the SDK (and the schemas it imports by package name) from source so no build step sits between an edit and a test run.
    alias: {
      '@kinesin/sdk': path.resolve(import.meta.dirname, '../../packages/sdk/src/index.ts'),
      '@kinesin/schemas': path.resolve(import.meta.dirname, '../../packages/schemas/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
})
