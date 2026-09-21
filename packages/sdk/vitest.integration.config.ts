import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Runs against the local Hatchet Lite + Postgres stack (pnpm hatchet:up).
// Every suite must fail loudly, never skip, when the stack is missing.
export default defineConfig({
  resolve: {
    alias: { '@kyuworks/schemas': path.resolve(import.meta.dirname, '../schemas/src/index.ts') },
  },
  test: {
    globalSetup: ['./vitest.integration.setup.ts'],
    setupFiles: ['./vitest.integration.clearBusTables.ts'],
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
