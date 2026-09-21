import { Client } from 'pg'
import { beforeAll } from 'vitest'
import { readConfig } from './src/config.js'

// shop_product (0002_shop.sql) and the demo workflow definition and version
// (0005_shop.sql) are migration seed and are never cleaned: no later migration
// re-inserts them. Tests also insert their own definition and version rows
// for random tenants, so those two tables grow per run on purpose; they are
// never truncated because the migrations seed them.
// shop_order_line references shop_order and shop_workflow_run
// references shop_order, so the set truncates in one statement.
const CLEAN_TABLES = [
  'shop_order_line',
  'shop_order',
  'shop_invoice',
  'shop_handler_log',
  'shop_workflow_step_log',
  'shop_workflow_run',
  'kyu_outbox',
  'kyu_processed',
]

// Runs once per integration file, before the file's own hooks. Vitest orders
// files by size, so a file that leaves rows behind lands on a different
// neighbour in CI than it does locally: no file may decide what the next
// file's first test sees.
beforeAll(async () => {
  const { databaseUrl } = readConfig()
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query(`TRUNCATE TABLE ${CLEAN_TABLES.join(', ')}`)
  } finally {
    await client.end()
  }
})
