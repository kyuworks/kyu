import { Client } from 'pg'
import { applyMigrations } from './src/db/applyMigrations.js'
import { MIGRATIONS_DIRECTORY } from './src/migrations.js'

// Global setup for the integration suite. A missing engine or database is a
// failure, not a skip: a suite that silently skips reports green for code it
// never ran.
export default async function setup(): Promise<void> {
  if (!process.env['HATCHET_CLIENT_TOKEN']) {
    throw new Error(
      [
        'HATCHET_CLIENT_TOKEN is not set, so the integration suite cannot reach an engine.',
        'Start the local stack and export a token:',
        '  pnpm hatchet:up',
        '  export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/token.sh)"',
        '  export HATCHET_CLIENT_TLS_STRATEGY=none',
      ].join('\n'),
    )
  }

  const testDatabaseUrl = process.env['KYU_TEST_DATABASE_URL']
  if (!testDatabaseUrl) {
    throw new Error(
      [
        'KYU_TEST_DATABASE_URL is not set, so the integration suite has no database.',
        'Point it at the Postgres the local engine stack exposes:',
        '  export KYU_TEST_DATABASE_URL="postgresql://hatchet:hatchet@localhost:15432/kyu_test"',
      ].join('\n'),
    )
  }

  // The database being recreated can never be the one the admin connection is
  // on, so its name is decoded straight from the URL, not hardcoded — the
  // admin statements run against Postgres's own `postgres` database instead.
  const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//, ''))
  if (!/^kyu_test[a-z0-9_]*$/.test(databaseName)) {
    throw new Error(
      `Refusing to touch database ${databaseName}: the integration harness only drops databases named ` +
        'kyu_test or kyu_test_<lane>.',
    )
  }

  const adminUrl = new URL(testDatabaseUrl)
  adminUrl.pathname = '/postgres'
  const admin = new Client({ connectionString: adminUrl.toString() })
  try {
    await admin.connect()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Cannot reach Postgres at ${adminUrl.host}: ${message}. Start the stack with \`pnpm hatchet:up\`.`,
      { cause: error },
    )
  }
  try {
    // A lingering session, or a Postgres that isn't the Kyu engine
    // stack, must never lose the `DROP DATABASE`. The stack's own `hatchet`
    // database is the marker that this is the right server.
    const marker = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'hatchet'")
    if (marker.rows.length === 0) {
      throw new Error(
        `Refusing to drop ${databaseName}: the server at ${adminUrl.host} is not the Kyu engine stack ` +
          '(no `hatchet` database). Point KYU_TEST_DATABASE_URL at the stack from infra/hatchet/compose.yaml.',
      )
    }
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('being accessed by other users')) {
        throw new Error(
          `Database ${databaseName} is in use by another session (another worktree's run, or an open psql). ` +
            `Give this lane its own database: KYU_TEST_DATABASE_URL=postgresql://…/kyu_test_<lane>.`,
          { cause: error },
        )
      }
      throw error
    }
    await admin.query(`CREATE DATABASE "${databaseName}"`)
  } finally {
    await admin.end()
  }

  const db = new Client({ connectionString: testDatabaseUrl })
  await db.connect()
  try {
    await applyMigrations(db, MIGRATIONS_DIRECTORY)
  } finally {
    await db.end()
  }
}
