import { MIGRATIONS_DIRECTORY } from '@kyuworks/sdk'
import { Client } from 'pg'
import { MissingConfigError, readConfig } from './src/config.js'
import { APP_MIGRATIONS_DIRECTORY, applyPending, ensureDatabase } from './src/db/migrate.js'

// shop_order_line references shop_order, so it must truncate in the same
// statement (0002_shop.sql); shop_product is seed data and is never cleaned.
// shop_workflow_definition and shop_workflow_version have no migration seed
// in this PR — tests insert their own rows directly and this suite never
// cleans them, so they grow by one per test tenant across runs. A seed
// migration arrives in a later PR.
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

// Global setup for the integration suite. A missing database is a failure,
// not a skip: a suite that silently skips reports green for code it never ran.
export default async function setup(): Promise<void> {
  let databaseUrl: string
  try {
    ;({ databaseUrl } = readConfig())
  } catch (error) {
    if (!(error instanceof MissingConfigError)) throw error
    throw new Error(
      [
        'KYU_SHOP_DATABASE_URL is not set, so the integration suite has no database.',
        'Start the local stack and point this lane at its own database:',
        '  pnpm hatchet:up',
        '  export KYU_SHOP_DATABASE_URL="postgresql://hatchet:hatchet@localhost:15432/kyu_shop_pr3"',
      ].join('\n'),
      { cause: error },
    )
  }

  await ensureDatabase(databaseUrl)

  const db = new Client({ connectionString: databaseUrl })
  await db.connect()
  try {
    await applyPending(db, [MIGRATIONS_DIRECTORY, APP_MIGRATIONS_DIRECTORY])
    await db.query(`TRUNCATE TABLE ${CLEAN_TABLES.join(', ')}`)
  } finally {
    await db.end()
  }
}
