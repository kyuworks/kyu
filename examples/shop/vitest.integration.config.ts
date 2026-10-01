import { configDefaults, defineConfig } from 'vitest/config'

// CI runs this suite as two jobs, KYU_INTEGRATION_SHARD=1 and =2; unset runs every file.
// Shard 2 is every file not listed here. Gate: scripts/gates/check-integration-shards.sh.
const INTEGRATION_SHARD_ONE_FILES = [
  'src/__tests__/workflow.integration.test.ts',
  'src/__tests__/crmFlow.integration.test.ts',
  'src/__tests__/busCounts.integration.test.ts',
]
const integrationShard = process.env['KYU_INTEGRATION_SHARD']
if (integrationShard !== undefined && integrationShard !== '1' && integrationShard !== '2') {
  throw new Error(`KYU_INTEGRATION_SHARD must be 1, 2 or unset, not "${integrationShard}".`)
}

// test:integration builds first, so @kyuworks/sdk resolves through its
// package exports against built JS, like every other consumer.
export default defineConfig({
  test: {
    globalSetup: ['./vitest.integration.setup.ts'],
    setupFiles: ['./vitest.integration.clearTables.ts'],
    include: integrationShard === '1' ? INTEGRATION_SHARD_ONE_FILES : ['src/**/*.integration.test.ts'],
    exclude:
      integrationShard === '2'
        ? [...configDefaults.exclude, ...INTEGRATION_SHARD_ONE_FILES]
        : [...configDefaults.exclude],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
