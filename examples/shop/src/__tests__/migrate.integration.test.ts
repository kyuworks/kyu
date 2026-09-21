import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MIGRATIONS_DIRECTORY, uuidv7 } from '@kyuworks/sdk'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readConfig } from '../config.js'
import { APP_MIGRATIONS_DIRECTORY, applyPending } from '../db/migrate.js'

// shop_order_line and shop_product are 0002_shop.sql's; shop_order_line
// references shop_order, so both must drop in the same statement. The four
// shop_workflow_* tables are 0004_shop.sql's, in their own FK chain.
const TABLES = [
  'shop_order_line',
  'shop_product',
  'shop_order',
  'shop_invoice',
  'shop_handler_log',
  'shop_workflow_step_log',
  'shop_workflow_run',
  'shop_workflow_version',
  'shop_workflow_definition',
  'kyu_outbox',
  'kyu_processed',
]

describe('applyPending', () => {
  const { databaseUrl } = readConfig()
  const client = new Client({ connectionString: databaseUrl })

  beforeAll(async () => {
    await client.connect()
  })

  afterAll(async () => {
    await client.end()
  })

  // Global setup already applied every migration once; drop what it
  // created so this test exercises a genuinely first run.
  beforeEach(async () => {
    await client.query(`DROP TABLE IF EXISTS shop_migrations, ${TABLES.join(', ')}`)
  })

  it('applies the SDK migration then the app migration, once', async () => {
    const first = await applyPending(client, [MIGRATIONS_DIRECTORY, APP_MIGRATIONS_DIRECTORY])
    expect(first).toEqual([
      '20260916233209_create_outbox.sql',
      '20260920232955_outbox_dead_at.sql',
      '20260922022251_outbox_publish_at.sql',
      '0001_shop.sql',
      '0002_shop.sql',
      '0003_shop.sql',
      '0004_shop.sql',
      '0005_shop.sql',
    ])

    const second = await applyPending(client, [MIGRATIONS_DIRECTORY, APP_MIGRATIONS_DIRECTORY])
    expect(second).toEqual([])

    const ledger = await client.query('SELECT name FROM shop_migrations')
    expect(ledger.rows).toHaveLength(8)

    for (const table of TABLES) {
      const exists = await client.query('SELECT 1 FROM information_schema.tables WHERE table_name = $1', [table])
      expect(exists.rows).toHaveLength(1)
    }
  })
})

describe('applyPending transaction check', () => {
  const { databaseUrl } = readConfig()
  const client = new Client({ connectionString: databaseUrl })
  let dir = ''

  beforeAll(async () => {
    await client.connect()
    dir = await mkdtemp(path.join(tmpdir(), 'kyu-shop-migrate-'))
  })

  afterAll(async () => {
    await client.end()
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects and rolls back a migration file that runs its own COMMIT', async () => {
    const file = '0000_throwaway.sql'
    await writeFile(path.join(dir, file), 'COMMIT;\n')

    await expect(applyPending(client, [dir])).rejects.toThrow(new RegExp(file))

    const ledger = await client.query('SELECT name FROM shop_migrations WHERE name = $1', [file])
    expect(ledger.rows).toHaveLength(0)
  })
})

describe('shop_handler_log unique index', () => {
  const { databaseUrl } = readConfig()
  const client = new Client({ connectionString: databaseUrl })

  beforeAll(async () => {
    await client.connect()
    // Re-applying is a no-op past the first run; it only guarantees the table exists.
    await applyPending(client, [MIGRATIONS_DIRECTORY, APP_MIGRATIONS_DIRECTORY])
  })

  afterAll(async () => {
    await client.end()
  })

  beforeEach(async () => {
    await client.query('TRUNCATE TABLE shop_handler_log')
  })

  it('rejects a second write for the same handler and envelope id', async () => {
    const envelopeId = uuidv7()
    const tenantId = uuidv7()
    const insert = 'INSERT INTO shop_handler_log (handler, envelope_id, tenant_id) VALUES ($1, $2, $3)'

    await client.query(insert, ['order.placed', envelopeId, tenantId])

    await expect(client.query(insert, ['order.placed', envelopeId, tenantId])).rejects.toMatchObject({
      code: '23505',
    })
  })
})
