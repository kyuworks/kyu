import { randomUUID } from 'node:crypto'
import { defineEvent, envelopeSchema } from '@kyuworks/schemas'
import { Client, DatabaseError } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { claimPendingRows } from './outboxRepository.js'
import { createPublisher, publishEnvelope } from './publish.js'

// Mandatory must-hold: a message published inside a transaction that rolls
// back is never delivered (rollback-never-delivers).

const thingHappened = defineEvent({
  name: 'kyu.outbox_test.happened',
  version: 1,
  data: z.object({ n: z.number() }),
})

let client: Client

beforeAll(async () => {
  client = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
  await client.connect()
})

afterAll(async () => {
  await client.end()
})

afterEach(async () => {
  await client.query('TRUNCATE kyu_outbox')
})

describe('publish via the outbox', () => {
  it('a rolled-back transaction leaves no outbox row', async () => {
    const publisher = createPublisher({ source: 'outbox-test' })

    await client.query('BEGIN')
    const envelope = await publisher.publish(client, thingHappened, { n: 1 }, { tenantId: null })

    // Positive control: the row exists on the same client before rollback,
    // so this test cannot pass a publish() that silently writes nothing.
    const beforeRollback = await client.query('SELECT count(*)::text AS count FROM kyu_outbox WHERE id = $1', [
      envelope.id,
    ])
    expect(Number(beforeRollback.rows[0]?.count)).toBe(1)

    await client.query('ROLLBACK')

    const result = await client.query('SELECT count(*)::text AS count FROM kyu_outbox WHERE id = $1', [envelope.id])
    expect(Number(result.rows[0]?.count)).toBe(0)
  })

  it('a committed transaction leaves exactly one row matching the returned envelope', async () => {
    const publisher = createPublisher({ source: 'outbox-test' })
    const tenantId = randomUUID()

    await client.query('BEGIN')
    const envelope = await publisher.publish(client, thingHappened, { n: 2 }, { tenantId })
    await client.query('COMMIT')

    const result = await client.query('SELECT name, tenant_id, envelope FROM kyu_outbox WHERE id = $1', [envelope.id])
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row?.name).toBe(envelope.name)
    expect(row?.tenant_id).toBe(envelope.tenantId)
    expect(envelopeSchema.parse(row?.envelope)).toEqual(envelope)
  })

  it('publishing the same envelope twice in one transaction rejects with the unique-violation error', async () => {
    const publisher = createPublisher({ source: 'outbox-test' })

    await client.query('BEGIN')
    const envelope = await publisher.publish(client, thingHappened, { n: 3 }, { tenantId: null })

    let caught: unknown
    try {
      await publishEnvelope(client, envelope)
    } catch (error) {
      caught = error
    }

    await client.query('ROLLBACK')

    if (!(caught instanceof DatabaseError)) throw new Error('expected a pg DatabaseError')
    expect(caught.code).toBe('23505')
  })

  it('a future publishAt is not claimed before its time and is claimed after', async () => {
    const publisher = createPublisher({ source: 'outbox-test' })
    const envelope = await publisher.publish(
      client,
      thingHappened,
      { n: 1 },
      {
        tenantId: null,
        publishAt: new Date(Date.now() + 2_000),
      },
    )

    const early = await claimPendingRows(client, { limit: 10, workerId: `w-${randomUUID()}`, staleAfterMs: 0 })
    expect(early.rows).toEqual([])

    await new Promise<void>((resolve) => setTimeout(resolve, 2_500))

    const late = await claimPendingRows(client, { limit: 10, workerId: `w-${randomUUID()}`, staleAfterMs: 0 })
    expect(late.rows.map((row) => row.id)).toEqual([envelope.id])
  }, 10_000)

  it('a scheduled publish in a rolled-back transaction leaves no row', async () => {
    const publisher = createPublisher({ source: 'outbox-test' })

    await client.query('BEGIN')
    const envelope = await publisher.publish(
      client,
      thingHappened,
      { n: 4 },
      {
        tenantId: null,
        publishAt: new Date(Date.now() + 3_600_000),
      },
    )

    const beforeRollback = await client.query('SELECT count(*)::text AS count FROM kyu_outbox WHERE id = $1', [
      envelope.id,
    ])
    expect(Number(beforeRollback.rows[0]?.count)).toBe(1)

    await client.query('ROLLBACK')

    const result = await client.query('SELECT count(*)::text AS count FROM kyu_outbox WHERE id = $1', [envelope.id])
    expect(Number(result.rows[0]?.count)).toBe(0)
  })
})
