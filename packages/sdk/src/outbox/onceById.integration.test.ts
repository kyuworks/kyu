import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { onceById } from './onceById.js'

// Mandatory must-holds: redelivery of the same envelope id is idempotent,
// and a body that throws inside a rolled-back transaction is retried.

let client: Client

beforeAll(async () => {
  client = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
  await client.connect()
})

afterAll(async () => {
  await client.end()
})

afterEach(async () => {
  await client.query('TRUNCATE kyu_processed')
})

describe('onceById', () => {
  it('runs the body once across repeated calls for the same envelope id and handler', async () => {
    const envelopeId = randomUUID()
    let calls = 0
    const fn = async (): Promise<number> => {
      calls += 1
      return calls
    }

    const first = await onceById(client, envelopeId, 'handler-a', fn)
    const second = await onceById(client, envelopeId, 'handler-a', fn)

    expect(first).toEqual({ ran: true, result: 1 })
    expect(second).toEqual({ ran: false })
    expect(calls).toBe(1)

    const rows = await client.query('SELECT count(*)::text AS count FROM kyu_processed WHERE envelope_id = $1', [
      envelopeId,
    ])
    expect(Number(rows.rows[0]?.count)).toBe(1)
  })

  it('runs again for a different handler name on the same envelope id', async () => {
    const envelopeId = randomUUID()
    let calls = 0
    const fn = async (): Promise<void> => {
      calls += 1
    }

    const first = await onceById(client, envelopeId, 'handler-a', fn)
    const second = await onceById(client, envelopeId, 'handler-b', fn)

    expect(first.ran).toBe(true)
    expect(second.ran).toBe(true)
    expect(calls).toBe(2)
  })

  it('leaves no processed row when the body throws inside a rolled-back transaction, so a retry reruns it', async () => {
    const envelopeId = randomUUID()
    let calls = 0
    const failingFn = async (): Promise<void> => {
      calls += 1
      throw new Error('boom')
    }

    await client.query('BEGIN')
    await expect(onceById(client, envelopeId, 'handler-a', failingFn)).rejects.toThrow('boom')

    // Positive control: the processed row exists on the same client before
    // rollback, so this test cannot pass an onceById() that never inserts it.
    const beforeRollback = await client.query(
      'SELECT count(*)::text AS count FROM kyu_processed WHERE envelope_id = $1',
      [envelopeId],
    )
    expect(Number(beforeRollback.rows[0]?.count)).toBe(1)

    await client.query('ROLLBACK')

    const afterRollback = await client.query(
      'SELECT count(*)::text AS count FROM kyu_processed WHERE envelope_id = $1',
      [envelopeId],
    )
    expect(Number(afterRollback.rows[0]?.count)).toBe(0)
    expect(calls).toBe(1)

    const succeedingFn = async (): Promise<void> => {
      calls += 1
    }
    const retry = await onceById(client, envelopeId, 'handler-a', succeedingFn)
    expect(retry.ran).toBe(true)
    expect(calls).toBe(2)
  })
})
