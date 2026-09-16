import { randomUUID } from 'node:crypto'
import { defineEvent, envelopeSchema } from '@kinesin/schemas'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPublisher } from './publish.js'

// Flow 2, mandatory must-hold: a message published inside a transaction that
// rolls back is never delivered (rollback-never-delivers).

const thingHappened = defineEvent({
  name: 'kinesin.outbox_test.happened',
  version: 1,
  data: z.object({ n: z.number() }),
})

let client: Client

beforeAll(async () => {
  client = new Client({ connectionString: process.env['KINESIN_TEST_DATABASE_URL'] })
  await client.connect()
})

afterAll(async () => {
  await client.end()
})

afterEach(async () => {
  await client.query('TRUNCATE kinesin_outbox')
})

describe('publish via the outbox (flow 2)', () => {
  it('a rolled-back transaction leaves no outbox row', async () => {
    const publisher = createPublisher({ source: 'outbox-test' })

    await client.query('BEGIN')
    const envelope = await publisher.publish(client, thingHappened, { n: 1 }, { tenantId: null })

    // Positive control: the row exists on the same client before rollback,
    // so this test cannot pass a publish() that silently writes nothing.
    const beforeRollback = await client.query('SELECT count(*)::text AS count FROM kinesin_outbox WHERE id = $1', [
      envelope.id,
    ])
    expect(Number(beforeRollback.rows[0]?.count)).toBe(1)

    await client.query('ROLLBACK')

    const result = await client.query('SELECT count(*)::text AS count FROM kinesin_outbox WHERE id = $1', [envelope.id])
    expect(Number(result.rows[0]?.count)).toBe(0)
  })

  it('a committed transaction leaves exactly one row matching the returned envelope', async () => {
    const publisher = createPublisher({ source: 'outbox-test' })
    const tenantId = randomUUID()

    await client.query('BEGIN')
    const envelope = await publisher.publish(client, thingHappened, { n: 2 }, { tenantId })
    await client.query('COMMIT')

    const result = await client.query('SELECT name, tenant_id, envelope FROM kinesin_outbox WHERE id = $1', [
      envelope.id,
    ])
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row?.name).toBe(envelope.name)
    expect(row?.tenant_id).toBe(envelope.tenantId)
    expect(envelopeSchema.parse(row?.envelope)).toEqual(envelope)
  })
})
