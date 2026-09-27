import path from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

// CI runs this suite as two jobs, KYU_INTEGRATION_SHARD=1 and =2; unset runs every file.
// Shard 2 is every file not listed here. Gate: scripts/gates/check-integration-shards.sh.
const INTEGRATION_SHARD_ONE_FILES = [
  'src/consume/rateLimits.integration.test.ts',
  'src/consume/fanOut.integration.test.ts',
  'src/consume/subscribe.integration.test.ts',
  'src/relay/relay.integration.test.ts',
]
const integrationShard = process.env['KYU_INTEGRATION_SHARD']
if (integrationShard !== undefined && integrationShard !== '1' && integrationShard !== '2') {
  throw new Error(`KYU_INTEGRATION_SHARD must be 1, 2 or unset, not "${integrationShard}".`)
}

// Runs against the local Hatchet Lite + Postgres stack (pnpm hatchet:up).
// Every suite must fail loudly, never skip, when the stack is missing.
export default defineConfig({
  resolve: {
    alias: { '@kyuworks/schemas': path.resolve(import.meta.dirname, '../schemas/src/index.ts') },
  },
  test: {
    globalSetup: ['./vitest.integration.setup.ts'],
    setupFiles: ['./vitest.integration.clearBusTables.ts'],
    include: integrationShard === '1' ? INTEGRATION_SHARD_ONE_FILES : ['src/**/*.integration.test.ts'],
    exclude:
      integrationShard === '2'
        ? [...configDefaults.exclude, ...INTEGRATION_SHARD_ONE_FILES]
        : [...configDefaults.exclude],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
