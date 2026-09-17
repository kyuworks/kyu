import { defineConfig } from 'vitest/config'

// test:integration is `pnpm run build && vitest run --config
// vitest.integration.config.ts`, so @kinesin/sdk resolves through its
// package exports against built JS, the same as any other consumer — no
// source alias here.
export default defineConfig({
  test: {
    globalSetup: ['./vitest.integration.setup.ts'],
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
