import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Proves the integration global setup (vitest.integration.setup.ts) did its
// job: `kinesin_test` exists, is reachable, and has the migrations applied
// before any suite's tests run.

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

  it('applied the outbox migration', async () => {
    const result = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    )
    const tableNames = result.rows.map((row) => row.tablename).sort()
    expect(tableNames).toEqual(['kinesin_outbox', 'kinesin_processed'])
  })
})
