import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'

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

  const testDatabaseUrl = process.env['KINESIN_TEST_DATABASE_URL']
  if (!testDatabaseUrl) {
    throw new Error(
      [
        'KINESIN_TEST_DATABASE_URL is not set, so the integration suite has no database.',
        'Point it at the Postgres the local engine stack exposes:',
        '  export KINESIN_TEST_DATABASE_URL="postgresql://hatchet:hatchet@localhost:5432/kinesin_test"',
      ].join('\n'),
    )
  }

  // The database being recreated can never be the one the admin connection is
  // on, so its name is decoded straight from the URL, not hardcoded — the
  // admin statements run against Postgres's own `postgres` database instead.
  const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//, ''))
  if (!/^[a-z_][a-z0-9_]*$/.test(databaseName)) {
    throw new Error(
      `KINESIN_TEST_DATABASE_URL's database name ${JSON.stringify(databaseName)} is not a plain identifier ` +
        '(expected /^[a-z_][a-z0-9_]*$/). Refusing to run DROP/CREATE DATABASE against it.',
    )
  }

  const adminUrl = new URL(testDatabaseUrl)
  adminUrl.pathname = '/postgres'
  const admin = new Client({ connectionString: adminUrl.toString() })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
    await admin.query(`CREATE DATABASE "${databaseName}"`)
  } finally {
    await admin.end()
  }

  const db = new Client({ connectionString: testDatabaseUrl })
  await db.connect()
  try {
    const migrationsDir = path.resolve(import.meta.dirname, 'migrations')
    const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8')
      await db.query('BEGIN')
      try {
        await db.query(sql)
        await db.query('COMMIT')
      } catch (error) {
        await db.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    await db.end()
  }
}
