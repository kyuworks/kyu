import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readConfig } from '../config.js'
import { createPool, logDroppedConnections, withTransaction } from './pool.js'

class Marker extends Error {}

describe('withTransaction', () => {
  const { databaseUrl } = readConfig()
  const admin = new Client({ connectionString: databaseUrl })
  const pool = createPool(databaseUrl, { max: 1 })

  beforeAll(async () => {
    await admin.connect()
    await admin.query('CREATE TABLE IF NOT EXISTS with_transaction_probe (id integer PRIMARY KEY)')
  })

  beforeEach(async () => {
    await admin.query('TRUNCATE TABLE with_transaction_probe')
  })

  afterAll(async () => {
    await admin.query('DROP TABLE IF EXISTS with_transaction_probe')
    await admin.end()
    await pool.end()
  })

  it('rolls back and rethrows when fn throws', async () => {
    await expect(
      withTransaction(pool, async (client) => {
        await client.query('INSERT INTO with_transaction_probe (id) VALUES (1)')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const rows = await admin.query('SELECT * FROM with_transaction_probe')
    expect(rows.rows).toHaveLength(0)
  })

  it('commits when fn resolves', async () => {
    await withTransaction(pool, async (client) => {
      await client.query('INSERT INTO with_transaction_probe (id) VALUES (1)')
    })

    const rows = await admin.query('SELECT * FROM with_transaction_probe')
    expect(rows.rows).toHaveLength(1)
  })

  it('rethrows the original error subclass, not a wrapped Error', async () => {
    await expect(
      withTransaction(pool, async () => {
        throw new Marker('boom')
      }),
    ).rejects.toBeInstanceOf(Marker)
  })
})

describe('logDroppedConnections', () => {
  const { databaseUrl } = readConfig()

  it('logs a terminated idle connection once and serves the next query from a fresh backend', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const pool = createPool(databaseUrl, { max: 1 })
    logDroppedConnections(pool, 'ui')
    const killer = new Client({ connectionString: databaseUrl })
    await killer.connect()
    try {
      const before = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const pid = before.rows[0]?.pid
      const dropped = new Promise<void>((resolve) => {
        pool.once('error', () => resolve())
      })

      await killer.query('SELECT pg_terminate_backend($1)', [pid])
      await dropped

      const after = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      expect(after.rows[0]?.pid).not.toBe(pid)
      const drops = write.mock.calls
        .map((call) => JSON.parse(String(call[0])) as { process: string; event: string; message: string })
        .filter((line) => line.event === 'db-connection-dropped')
      expect(drops).toHaveLength(1)
      expect(drops[0]?.process).toBe('ui')
      expect(drops[0]?.message).not.toBe('')
    } finally {
      vi.restoreAllMocks()
      await killer.end()
      await pool.end()
    }
  })
})
