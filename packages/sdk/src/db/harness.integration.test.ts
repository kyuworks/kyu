import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Proves the integration global setup (vitest.integration.setup.ts) did its
// job: `kinesin_test` exists and is reachable before any suite's tests run.
// Assert only what the harness guarantees today — migrations arrive later.

let client: Client

beforeAll(async () => {
  client = new Client({ connectionString: process.env['KINESIN_TEST_DATABASE_URL'] })
  await client.connect()
})

afterAll(async () => {
  await client.end()
})

const databaseName = decodeURIComponent(
  new URL(process.env['KINESIN_TEST_DATABASE_URL'] ?? '').pathname.replace(/^\//, ''),
)

describe('integration test harness', () => {
  it('connects to the configured test database', async () => {
    const result = await client.query<{ current_database: string }>('SELECT current_database()')
    expect(result.rows[0]?.current_database).toBe(databaseName)
  })

  it('recreated the database with no tables yet', async () => {
    // No `.sql` migration files exist yet; PR-2's migration raises this to 2.
    const result = await client.query<{ count: string }>("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
    expect(Number(result.rows[0]?.count)).toBe(0)
  })
})
