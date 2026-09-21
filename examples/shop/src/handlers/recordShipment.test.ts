import { randomUUID } from 'node:crypto'
import type { HandlerContext, HatchetClient, Kyu, MessageData } from '@kyuworks/sdk'
import { NonRetryableError, createEnvelope, createKyu, onceById } from '@kyuworks/sdk'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { orderShipped } from '../messages.js'
import { handleRecordShipment, recordShipmentSubscription } from './recordShipment.js'

type OrderShippedContext = HandlerContext<MessageData<typeof orderShipped>>

// The statement text is pinned once in handlerLog.test.ts; this file only
// checks that its own handler writes the row with its own values.
const isLogInsert = (text: string): boolean => text.startsWith('INSERT INTO shop_handler_log')

interface FakeClientOptions {
  orderExists: boolean
  alreadyProcessed: boolean
}

// Branches on the statement text, the same fake-a-table idiom
// packages/sdk/src/outbox/onceById.test.ts uses for its Queryable.
function fakeClient(events: string[], params: unknown[][], options: FakeClientOptions): PoolClient {
  const stub: Pick<PoolClient, 'query' | 'release'> = {
    query: ((text: string, queryParams?: readonly unknown[]) => {
      events.push(text)
      params.push(queryParams !== undefined ? [...queryParams] : [])
      if (text.startsWith('INSERT INTO kyu_processed')) {
        return options.alreadyProcessed
          ? Promise.resolve({ rows: [], rowCount: 0 })
          : Promise.resolve({ rows: [{ envelope_id: queryParams?.[0] }], rowCount: 1 })
      }
      if (text.startsWith('UPDATE shop_order')) {
        return Promise.resolve(
          options.orderExists ? { rows: [{ id: queryParams?.[0] }], rowCount: 1 } : { rows: [], rowCount: 0 },
        )
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    }) as PoolClient['query'],
    release: () => {
      events.push('RELEASE')
    },
  }
  return stub as PoolClient
}

function fakePool(client: PoolClient): Pool {
  const stub: Pick<Pool, 'connect'> = { connect: (() => Promise.resolve(client)) as Pool['connect'] }
  return stub as Pool
}

// onceById is a plain function of a Queryable; the real one runs unmocked here.
function fakeKyu(): Kyu {
  const stub: Pick<Kyu, 'onceById'> = { onceById }
  return stub as Kyu
}

async function buildContext(orderId: string, carrier: string, tenantId: string): Promise<OrderShippedContext> {
  const envelope = await createEnvelope(orderShipped, { orderId, carrier }, { tenantId, source: 'test' })
  return {
    envelope,
    metadata: {
      envelopeId: envelope.id,
      name: envelope.name,
      version: envelope.version,
      kind: envelope.kind,
      tenantId: envelope.tenantId,
      correlationId: envelope.correlationId,
      source: envelope.source,
    },
    retryCount: 0,
    runId: 'unit-test-run',
    signal: new AbortController().signal,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  }
}

describe('handleRecordShipment', () => {
  it('writes the shipped time and the log row, carrying the carrier as the note', async () => {
    const orderId = randomUUID()
    const tenantId = randomUUID()
    const events: string[] = []
    const params: unknown[][] = []
    const pool = fakePool(fakeClient(events, params, { orderExists: true, alreadyProcessed: false }))
    const ctx = await buildContext(orderId, 'ups', tenantId)

    await handleRecordShipment(pool, fakeKyu(), ctx)

    expect(events.some(isLogInsert)).toBe(true)
    const updateIndex = events.findIndex((event) => event.startsWith('UPDATE shop_order'))
    // Pins the coalesce: a plain `$2::timestamptz` would also pass the params
    // assertion below but would let a second shipment move an already-set time.
    expect(events[updateIndex]).toContain('coalesce(shipped_at,')
    expect(params[updateIndex]).toEqual([orderId, ctx.envelope.occurredAt, tenantId])
    const logIndex = events.findIndex(isLogInsert)
    expect(params[logIndex]).toEqual(['record-shipment', ctx.envelope.id, orderId, tenantId, process.pid, 'ups'])
  })

  it('throws NonRetryableError naming the order when no shop_order row matches the tenant', async () => {
    const orderId = randomUUID()
    const tenantId = randomUUID()
    const events: string[] = []
    const params: unknown[][] = []
    const pool = fakePool(fakeClient(events, params, { orderExists: false, alreadyProcessed: false }))
    const ctx = await buildContext(orderId, 'ups', tenantId)

    const rejection = handleRecordShipment(pool, fakeKyu(), ctx)
    await expect(rejection).rejects.toThrow(new RegExp(orderId))
    await expect(rejection).rejects.toBeInstanceOf(NonRetryableError)
    expect(events.some(isLogInsert)).toBe(false)
  })

  it('skips the update and the log row when the envelope was already processed', async () => {
    const orderId = randomUUID()
    const tenantId = randomUUID()
    const events: string[] = []
    const params: unknown[][] = []
    const pool = fakePool(fakeClient(events, params, { orderExists: true, alreadyProcessed: true }))
    const ctx = await buildContext(orderId, 'ups', tenantId)

    await handleRecordShipment(pool, fakeKyu(), ctx)

    expect(events.some(isLogInsert)).toBe(false)
    expect(events.some((event) => event.startsWith('UPDATE shop_order'))).toBe(false)
  })
})

// Mirrors subscriptions.test.ts's fakeHatchetClient: real task()/durableTask()
// return values, so a real Subscription (name/kind/messageName) comes back
// without spinning up the engine client.
function fakeHatchetClient(): HatchetClient {
  const stub: Pick<HatchetClient, 'task' | 'durableTask' | 'worker'> = {
    task: (_options: Parameters<HatchetClient['task']>[0]) => ({}) as ReturnType<HatchetClient['task']>,
    durableTask: (_options: Parameters<HatchetClient['durableTask']>[0]) =>
      ({}) as ReturnType<HatchetClient['durableTask']>,
    worker: (_name: string) => new Promise<never>(() => undefined),
  }
  return stub as HatchetClient
}

describe('recordShipmentSubscription', () => {
  it('subscribes as an event named record-shipment on shop.order.shipped', () => {
    const events: string[] = []
    const params: unknown[][] = []
    const pool = fakePool(fakeClient(events, params, { orderExists: true, alreadyProcessed: false }))
    const kyu = createKyu({ hatchet: fakeHatchetClient(), source: 'record-shipment-test' })

    const subscription = recordShipmentSubscription(kyu, pool)

    expect(subscription).toMatchObject({ name: 'record-shipment', kind: 'event', messageName: 'shop.order.shipped' })
  })
})
