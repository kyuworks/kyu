import { MIGRATIONS_DIRECTORY } from '@qtaxis/sdk'
import { Client } from 'pg'
import { MissingConfigError, readConfig } from './src/config.js'
import { APP_MIGRATIONS_DIRECTORY, applyPending, ensureDatabase } from './src/db/migrate.js'

const CLEAN_TABLES = ['shop_order', 'shop_invoice', 'shop_handler_log', 'qtaxis_outbox', 'qtaxis_processed']

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
        'QTAXIS_SHOP_DATABASE_URL is not set, so the integration suite has no database.',
        'Start the local stack and point this lane at its own database:',
        '  pnpm hatchet:up',
        '  export QTAXIS_SHOP_DATABASE_URL="postgresql://hatchet:hatchet@localhost:15432/qtaxis_shop_pr3"',
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
