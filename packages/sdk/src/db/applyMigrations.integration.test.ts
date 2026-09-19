import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MigrationTransactionError, applyMigrations } from './applyMigrations.js'

// Proves the harness catches a migration file that ends or replaces the
// transaction it was opened in, by checking Postgres's own transaction id
// rather than guessing from SQL text. Each test gets a private schema so
// the shared kyu_test database stays clean between tests.

let client: Client
let schema: string

beforeEach(async () => {
  client = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
  await client.connect()
  schema = `apply_migrations_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`
  await client.query(`CREATE SCHEMA "${schema}"`)
})

afterEach(async () => {
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await client.end()
})

function writeMigrationDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kyu-migrations-'))
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), sql, 'utf8')
  }
  return dir
}

describe('applyMigrations', () => {
  it('rejects a file that rolls back mid-file, and leaves no table behind', async () => {
    // Nothing follows the ROLLBACK: once it ends the transaction the harness
    // opened, the file has no further statements to auto-commit outside it
    // (see the COMMIT case below for what happens when it does).
    const dir = writeMigrationDir({
      '20260101000000_bad.sql': `CREATE TABLE "${schema}".x (id int); ROLLBACK;`,
    })

    await expect(applyMigrations(client, dir)).rejects.toThrow(MigrationTransactionError)
    await expect(applyMigrations(client, dir)).rejects.toThrow(/20260101000000_bad\.sql/)

    const tables = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = '${schema}'`,
    )
    expect(Number(tables.rows[0]?.count)).toBe(0)
  })

  it('rejects a file that commits mid-file (the reason the rule exists)', async () => {
    // The COMMIT inside the file commits table x, and — because a statement
    // after an explicit COMMIT or ROLLBACK runs in its own auto-committed
    // transaction, outside anything the harness controls — table y commits
    // too. So this test only asserts the error, not the post-state of x or
    // y, which the harness cannot undo once the file has committed them
    // itself. This is exactly why the rule exists.
    const dir = writeMigrationDir({
      '20260101000001_bad.sql': `CREATE TABLE "${schema}".x (id int); COMMIT; CREATE TABLE "${schema}".y (id int);`,
    })

    await expect(applyMigrations(client, dir)).rejects.toThrow(MigrationTransactionError)
    await expect(applyMigrations(client, dir)).rejects.toThrow(/20260101000001_bad\.sql/)
  })

  it('applies a PL/pgSQL trigger function with a BEGIN ... END body', async () => {
    const dir = writeMigrationDir({
      '20260101000002_trigger.sql': `
        CREATE FUNCTION "${schema}".touch_updated_at() RETURNS trigger AS $$
        BEGIN
          NEW.id = NEW.id;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `,
    })

    const applied = await applyMigrations(client, dir)

    expect(applied).toEqual(['20260101000002_trigger.sql'])
    const fn = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = '${schema}' AND p.proname = 'touch_updated_at'`,
    )
    expect(Number(fn.rows[0]?.count)).toBe(1)
  })

  it('rejects CREATE INDEX CONCURRENTLY with the Postgres error', async () => {
    const dir = writeMigrationDir({
      '20260101000003_index.sql': `
        CREATE TABLE "${schema}".x (id int);
        CREATE INDEX CONCURRENTLY idx_x_id ON "${schema}".x (id);
      `,
    })

    await expect(applyMigrations(client, dir)).rejects.toThrow(/cannot run inside a transaction block/)
  })

  it('applies files in name order', async () => {
    const dir = writeMigrationDir({
      '20260101000005_second.sql': `CREATE TABLE "${schema}".second (id int);`,
      '20260101000004_first.sql': `CREATE TABLE "${schema}".first (id int);`,
    })

    const applied = await applyMigrations(client, dir)

    expect(applied).toEqual(['20260101000004_first.sql', '20260101000005_second.sql'])
  })
})
