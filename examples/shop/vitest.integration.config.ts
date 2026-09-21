import { defineConfig } from 'vitest/config'

// test:integration builds first, so @kyuworks/sdk resolves through its
// package exports against built JS, like every other consumer.
export default defineConfig({
  test: {
    globalSetup: ['./vitest.integration.setup.ts'],
    setupFiles: ['./vitest.integration.clearTables.ts'],
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
