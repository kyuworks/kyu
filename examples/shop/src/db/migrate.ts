import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Queryable } from '@kyuworks/sdk'
import { Client } from 'pg'
import { z } from 'zod'

const SHOP_DATABASE_NAME_PATTERN = /^kyu_shop[a-z0-9_]*$/

// Computed the same way the SDK locates its own shipped migrations/: two
// levels up from this file, whether running from src/ (vitest) or dist/ (built).
export const APP_MIGRATIONS_DIRECTORY: string = path.resolve(import.meta.dirname, '../../migrations')

/** `databaseUrl` was not a valid URL, so no database name could be read from it. */
export class InvalidDatabaseUrlError extends Error {
  constructor(databaseUrl: string, cause: TypeError) {
    super(`invalid database url: "${databaseUrl}"`, { cause })
    this.name = 'InvalidDatabaseUrlError'
  }
}

/** The target database name, or throws before any connection is opened. */
export function assertShopDatabaseName(databaseUrl: string): string {
  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch (error) {
    if (error instanceof TypeError) throw new InvalidDatabaseUrlError(databaseUrl, error)
    throw error
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!SHOP_DATABASE_NAME_PATTERN.test(name)) {
    throw new Error(
      `refusing to create database "${name}": the shop only creates databases matching ` +
        SHOP_DATABASE_NAME_PATTERN.source,
    )
  }
  return name
}

/** What bin/migrate.ts logs for its start/failed events — the database name only, never the connection string. */
export function migrateLogFields(databaseUrl: string) {
  return { database: assertShopDatabaseName(databaseUrl) }
}

// Connects to the server's own `postgres` database and creates the target
// database when missing. Never drops anything.
export async function ensureDatabase(databaseUrl: string): Promise<void> {
  const name = assertShopDatabaseName(databaseUrl)

  const adminUrl = new URL(databaseUrl)
  adminUrl.pathname = '/postgres'
  const admin = new Client({ connectionString: adminUrl.toString() })
  await admin.connect()
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    if (existing.rows.length === 0) {
      await admin.query(`CREATE DATABASE "${name}"`)
    }
  } finally {
    await admin.end()
  }
}

async function ensureLedger(client: Queryable): Promise<void> {
  await client.query(
    'CREATE TABLE IF NOT EXISTS shop_migrations (name text primary key, applied_at timestamptz not null default now())',
    [],
  )
}

interface Listing {
  directory: string
  files: readonly string[]
}

async function listSqlFiles(directory: string): Promise<Listing> {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()
  return { directory, files }
}

// A file name is the ledger key, so no name may appear in more than one directory.
function assertNoDuplicateNames(listings: readonly Listing[]): void {
  const seen = new Set<string>()
  for (const { files } of listings) {
    for (const file of files) {
      if (seen.has(file)) throw new Error(`migration ${file} is named in more than one migrations directory`)
      seen.add(file)
    }
  }
}

const xactIdRowSchema = z.object({ xid: z.string().nullable() })

// Applies every *.sql file not yet in the ledger, directory by directory,
// file by file in name order, each inside its own transaction.
export async function applyPending(client: Queryable, directories: readonly string[]): Promise<readonly string[]> {
  const listings = await Promise.all(directories.map(listSqlFiles))
  assertNoDuplicateNames(listings)
  await ensureLedger(client)

  const applied: string[] = []
  for (const { directory, files } of listings) {
    for (const file of files) {
      const already = await client.query('SELECT 1 FROM shop_migrations WHERE name = $1', [file])
      if (already.rows.length > 0) continue

      const sql = await readFile(path.join(directory, file), 'utf8')
      await client.query('BEGIN', [])
      try {
        const before = await client.query('SELECT pg_current_xact_id()::text AS xid', [])
        const openedXid = xactIdRowSchema.parse(before.rows[0]).xid
        // Empty params keep pg on the simple protocol, which is what lets one file hold several statements.
        await client.query(sql, [])
        const after = await client.query('SELECT pg_current_xact_id_if_assigned()::text AS xid', [])
        const currentXid = xactIdRowSchema.parse(after.rows[0]).xid
        if (currentXid === null || currentXid !== openedXid) {
          throw new Error('ended or replaced the transaction the harness opened around it')
        }
        await client.query('INSERT INTO shop_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT', [])
      } catch (error) {
        try {
          await client.query('ROLLBACK', [])
        } catch {
          // The connection may already be broken; the original error below is what matters.
        }
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`migration ${file} failed: ${message}`, { cause: error })
      }
      applied.push(file)
    }
  }
  return applied
}
