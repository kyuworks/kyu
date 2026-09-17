import { Pool } from 'pg'
import type { PoolClient } from 'pg'

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl })
}

// pg.PoolClient satisfies @kinesin/sdk's Queryable, so the client handed to
// `fn` is what publish() and onceById() take.
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // The connection may already be broken; the original error below is what matters.
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`transaction rolled back: ${message}`, { cause: error })
  } finally {
    client.release()
  }
}
