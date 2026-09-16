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

describe('integration test harness', () => {
  it('connects to the kinesin_test database', async () => {
    const result = await client.query<{ current_database: string }>('SELECT current_database()')
    expect(result.rows[0]?.current_database).toBe('kinesin_test')
  })

  it('reports a table count for the public schema', async () => {
    const result = await client.query<{ count: string }>("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
    expect(Number(result.rows[0]?.count)).toBeGreaterThanOrEqual(0)
  })
})
