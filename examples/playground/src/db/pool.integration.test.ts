import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readConfig } from '../config.js'
import { createPool, withTransaction } from './pool.js'

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
