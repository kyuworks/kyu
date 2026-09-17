import { randomBytes, randomUUID } from 'node:crypto'
import { defineEvent } from '@kinesin/schemas'
import type { Envelope, EnvelopeMetadataFields } from '@kinesin/schemas'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { HandlerContext } from './consume/handlerContext.js'
import type { KinesinWorker } from './consume/worker.js'
import { createKinesin } from './createKinesin.js'
import { createHatchetClient } from './hatchet.js'

// Namespaced per run so parallel worktrees sharing one engine do not see
// each other's events (relay.integration.test.ts's own convention).
const namespace = `ck${randomBytes(3).toString('hex')}_`
const hatchet = createHatchetClient({ namespace })
const kinesin = createKinesin({ hatchet, source: 'createKinesin-e2e-test' })

const delivered = defineEvent({
  name: 'kinesin.create_kinesin_test.delivered',
  version: 1,
  data: z.object({ n: z.number() }),
})

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  if (resolve === undefined) {
    throw new Error('unreachable: the Promise executor runs synchronously')
  }
  return { promise, resolve }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  const result = await Promise.race([promise, timeout])
  clearTimeout(timer)
  return result
}

let client: Client
// The relay's own connection: sharing `client` would put its 60 s poll on
// the same connection the test runs BEGIN/publish/COMMIT on, inside the
// 120 s retry budget below.
let relayDb: Client

beforeAll(async () => {
  client = new Client({ connectionString: process.env['KINESIN_TEST_DATABASE_URL'] })
  await client.connect()
  relayDb = new Client({ connectionString: process.env['KINESIN_TEST_DATABASE_URL'] })
  await relayDb.connect()
})

afterAll(async () => {
  await client.end()
  await relayDb.end()
})

afterEach(async () => {
  await client.query('TRUNCATE kinesin_outbox, kinesin_processed')
})

interface Received {
  envelope: Envelope<{ n: number }>
  metadata: EnvelopeMetadataFields
}

describe('createKinesin end to end', () => {
  it('publishes through the outbox, relays, and a redelivery does not re-run the idempotent handler', async () => {
    const received = deferred<Received>()

    // A fresh pg Client per invocation: the worker can run handlers for
    // several publish attempts concurrently, and a shared client's BEGIN
    // would silently join whichever transaction is already open on it.
    const subscription = kinesin.subscribe(delivered, {
      name: 'e2e-handler',
      handler: async (ctx: HandlerContext<{ n: number }>) => {
        const handlerDb = new Client({ connectionString: process.env['KINESIN_TEST_DATABASE_URL'] })
        await handlerDb.connect()
        // Captured inside the onceById body and resolved only after COMMIT:
        // another connection's read must never observe this row before the
        // transaction that wrote it has actually committed.
        let receivedHere: Received | undefined
        try {
          await handlerDb.query('BEGIN')
          await kinesin.onceById(handlerDb, ctx.envelope.id, 'e2e-handler', () => {
            receivedHere = { envelope: ctx.envelope, metadata: ctx.metadata }
            return Promise.resolve()
          })
          await handlerDb.query('COMMIT')
        } catch (error) {
          await handlerDb.query('ROLLBACK')
          throw error
        } finally {
          await handlerDb.end()
        }
        if (receivedHere !== undefined) received.resolve(receivedHere)
      },
    })

    const relay = kinesin.startRelay({ db: relayDb, workerId: `worker-${randomUUID()}`, pollIntervalMs: 60_000 })
    let worker: KinesinWorker | undefined

    try {
      worker = await kinesin.worker('kinesin-sdk-createkinesin-integration', { subscriptions: [subscription] })
      void worker.start()
      await worker.waitUntilReady()

      // A fresh workflow's first delivery can lag by a minute on a cold
      // engine (relay.integration.test.ts's own margin); retry with a
      // fresh envelope until one arrives.
      const retryIntervalMs = 5_000
      const budgetMs = 120_000
      const deadline = Date.now() + budgetMs
      const published: Array<{ envelope: Envelope<{ n: number }>; tenantId: string }> = []
      let result: Received | null = null

      while (result === null && Date.now() < deadline) {
        const tenantId = randomUUID()
        await client.query('BEGIN')
        const envelope = await kinesin.publish(client, delivered, { n: 7 }, { tenantId })
        await client.query('COMMIT')
        published.push({ envelope, tenantId })

        await relay.tick()
        result = await withTimeout(received.promise, retryIntervalMs)
      }
      if (result === null) throw new Error('the handler never received a published envelope')
      const receivedEnvelopeId = result.envelope.id

      const match = published.find((entry) => entry.envelope.id === receivedEnvelopeId)
      if (match === undefined) throw new Error('received an envelope that was never published by this test')

      expect(result.envelope).toEqual(match.envelope)
      expect(result.envelope.tenantId).toBe(match.tenantId)
      expect(result.metadata.envelopeId).toBe(match.envelope.id)

      // Redeliver the same envelope id straight through onceById — the
      // mandatory row (AGENTS.md § Test-driven changes): redelivery must not
      // re-run the handler body.
      const redelivery = await kinesin.onceById(client, match.envelope.id, 'e2e-handler', () => {
        throw new Error('onceById must not re-run the handler body on redelivery')
      })
      expect(redelivery).toEqual({ ran: false })

      const processed = await client.query(
        'SELECT count(*)::text AS count FROM kinesin_processed WHERE envelope_id = $1 AND handler = $2',
        [match.envelope.id, 'e2e-handler'],
      )
      expect(Number(processed.rows[0]?.['count'])).toBe(1)
    } finally {
      await relay.stop()
      await worker?.stop()
    }
  }, 180_000)
})
