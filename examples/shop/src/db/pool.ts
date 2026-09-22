import { Pool } from 'pg'
import type { PoolClient, PoolConfig } from 'pg'
import { describeError, log } from '../log.js'

export function createPool(databaseUrl: string, options?: Pick<PoolConfig, 'max'>): Pool {
  return new Pool({ connectionString: databaseUrl, ...options })
}

// pg emits this only for an idle client (pg-pool's idleListener); with no
// listener EventEmitter throws and the process dies. pg replaces the
// connection on the next query, so logging is the whole fix.
export function logDroppedConnections(pool: Pool, proc: string): void {
  pool.on('error', (error) => {
    log(proc, 'db-connection-dropped', { message: describeError(error) })
  })
}

// pg.PoolClient satisfies @kyuworks/sdk's Queryable, so the client handed to
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
