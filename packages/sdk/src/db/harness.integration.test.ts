import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Proves the integration global setup (vitest.integration.setup.ts) did its
// job: `kyu_test` exists, is reachable, and has the migrations applied
// before any suite's tests run.

let client: Client

beforeAll(async () => {
  client = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
  await client.connect()
})

afterAll(async () => {
  await client.end()
})

const databaseName = decodeURIComponent(new URL(process.env['KYU_TEST_DATABASE_URL'] ?? '').pathname.replace(/^\//, ''))

describe('integration test harness', () => {
  it('starts with empty bus tables', async () => {
    const outboxCount = await client.query<{ count: number }>('SELECT count(*)::int FROM kyu_outbox')
    const processedCount = await client.query<{ count: number }>('SELECT count(*)::int FROM kyu_processed')
    expect(outboxCount.rows[0]?.count).toBe(0)
    expect(processedCount.rows[0]?.count).toBe(0)
  })

  it('connects to the configured test database', async () => {
    const result = await client.query<{ current_database: string }>('SELECT current_database()')
    expect(result.rows[0]?.current_database).toBe(databaseName)
  })

  it('applied the outbox migration', async () => {
    const result = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    )
    const tableNames = result.rows.map((row) => row.tablename).sort()
    expect(tableNames).toEqual(['kyu_outbox', 'kyu_processed'])
  })
})
