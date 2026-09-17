import { MIGRATIONS_DIRECTORY } from '@kinesin/sdk'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readConfig } from '../config.js'
import { APP_MIGRATIONS_DIRECTORY, applyPending } from '../db/migrate.js'

const TABLES = ['shop_order', 'shop_invoice', 'shop_handler_log', 'kinesin_outbox', 'kinesin_processed']

describe('applyPending', () => {
  const { databaseUrl } = readConfig()
  const client = new Client({ connectionString: databaseUrl })

  beforeAll(async () => {
    await client.connect()
  })

  afterAll(async () => {
    await client.end()
  })

  // The global setup already applied every migration once; drop what it
  // created so this test exercises a genuinely first run, without dropping
  // the database itself.
  beforeEach(async () => {
    await client.query(`DROP TABLE IF EXISTS playground_migrations, ${TABLES.join(', ')}`)
  })

  it('applies the SDK migration then the app migration, once', async () => {
    const first = await applyPending(client, [MIGRATIONS_DIRECTORY, APP_MIGRATIONS_DIRECTORY])
    expect(first).toEqual(['20260916233209_create_outbox.sql', '0001_playground.sql'])

    const second = await applyPending(client, [MIGRATIONS_DIRECTORY, APP_MIGRATIONS_DIRECTORY])
    expect(second).toEqual([])

    const ledger = await client.query('SELECT name FROM playground_migrations')
    expect(ledger.rows).toHaveLength(2)

    for (const table of TABLES) {
      const exists = await client.query('SELECT 1 FROM information_schema.tables WHERE table_name = $1', [table])
      expect(exists.rows).toHaveLength(1)
    }
  })
})
