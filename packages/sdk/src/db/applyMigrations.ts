import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

// The minimal query surface applyMigrations needs. pg's Client satisfies
// this structurally; tests can pass anything that does.
export interface MigrationClient {
  query(text: string): Promise<{ rows: ReadonlyArray<{ xid?: string | null }> }>
}

// Thrown when a migration file does not leave the transaction the harness
// opened around it (it ran its own BEGIN/COMMIT/ROLLBACK/SAVEPOINT, or a
// statement such as CREATE INDEX CONCURRENTLY implicitly ended it).
export class MigrationTransactionError extends Error {
  readonly file: string

  constructor(file: string) {
    super(
      `migration ${file} ended or replaced the transaction the harness opened around it; ` +
        'migration files must not contain BEGIN, COMMIT, ROLLBACK, SAVEPOINT or CREATE INDEX CONCURRENTLY',
    )
    this.name = 'MigrationTransactionError'
    this.file = file
  }
}

// Applies every *.sql file in `directory`, in name order, each inside its
// own transaction. Postgres's own transaction id is the check: recorded
// before the file runs and compared after, so a file that runs BEGIN,
// COMMIT, ROLLBACK, SAVEPOINT or CREATE INDEX CONCURRENTLY (which cannot
// run inside a transaction block) is caught precisely, not guessed at by a
// SQL tokenizer. Returns the applied file names.
export async function applyMigrations(client: MigrationClient, directory: string): Promise<ReadonlyArray<string>> {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()

  for (const file of files) {
    const sql = await readFile(path.join(directory, file), 'utf8')
    await client.query('BEGIN')
    try {
      const before = await client.query('SELECT pg_current_xact_id()::text AS xid')
      const openedXid = before.rows[0]?.xid ?? null

      await client.query(sql)

      const after = await client.query('SELECT pg_current_xact_id_if_assigned()::text AS xid')
      const currentXid = after.rows[0]?.xid ?? null

      if (currentXid === null || currentXid !== openedXid) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // The connection may already be broken (e.g. the failure above
          // killed it); MigrationTransactionError below is what matters.
        }
        throw new MigrationTransactionError(file)
      }

      await client.query('COMMIT')
    } catch (error) {
      if (error instanceof MigrationTransactionError) {
        throw error
      }
      try {
        await client.query('ROLLBACK')
      } catch {
        // The connection may already be broken (e.g. the failure above
        // killed it); the original error below is what matters.
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`migration ${file} failed: ${message}`, { cause: error })
    }
  }

  return files
}
