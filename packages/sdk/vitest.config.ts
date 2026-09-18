import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Tests read the schemas package from source so no build step sits between an edit and a test run.
    alias: { '@qtaxis/schemas': path.resolve(import.meta.dirname, '../schemas/src/index.ts') },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
})
