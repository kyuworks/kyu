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

  // `kinesin_test` cannot be dropped or created while connected to it, so the
  // admin statements run against the engine's own `hatchet` database on the
  // same server.
  const adminUrl = new URL(testDatabaseUrl)
  adminUrl.pathname = '/hatchet'
  const admin = new Client({ connectionString: adminUrl.toString() })
  await admin.connect()
  try {
    await admin.query('DROP DATABASE IF EXISTS kinesin_test')
    await admin.query('CREATE DATABASE kinesin_test')
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
