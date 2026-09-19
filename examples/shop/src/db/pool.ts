import { Pool } from 'pg'
import type { PoolClient, PoolConfig } from 'pg'

export function createPool(databaseUrl: string, options?: Pick<PoolConfig, 'max'>): Pool {
  return new Pool({ connectionString: databaseUrl, ...options })
}

// pg.PoolClient satisfies @qtaxis/sdk's Queryable, so the client handed to
// `fn` is what publish() and onceById() take. A nested call takes a second
// connection from the pool and commits independently; do not nest.
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
      // The connection may already be broken; keep releasing the client below.
    }
    throw error
  } finally {
    client.release()
  }
}
