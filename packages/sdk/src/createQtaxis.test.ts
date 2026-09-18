import { defineEvent, uuidv7 } from '@qtaxis/schemas'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { z } from 'zod'
import { createQtaxis } from './createQtaxis.js'
import type { QtaxisRelayOptions } from './createQtaxis.js'
import type { Queryable, QueryParam, QueryRows } from './db/queryable.js'
import type {
  CreateDurableTaskWorkflowOpts,
  CreateTaskWorkflowOpts,
  CreateWorkerOpts,
  HatchetClient,
  JsonObject,
  TaskWorkflowDeclaration,
  Worker,
} from './hatchet.js'
import { outboxRowSchema } from './outbox/rows.js'
import type { OutboxRow } from './outbox/rows.js'
import type { PushItem } from './relay/index.js'

const orderPlaced = defineEvent({
  name: 'shop.order.placed',
  version: 1,
  data: z.object({ orderId: z.string() }),
})

function fakeWorker(): Worker {
  const stub: Pick<Worker, 'start' | 'stop' | 'waitUntilReady'> = {
    start: () => new Promise<void>(() => undefined),
    stop: () => Promise.resolve(),
    waitUntilReady: () => Promise.resolve(),
  }
  return stub as Worker
}

interface FakeHatchetClient {
  client: HatchetClient
  capturedTaskOptions: () => CreateTaskWorkflowOpts | undefined
  capturedDurableOptions: () => CreateDurableTaskWorkflowOpts<JsonObject, void> | undefined
  capturedWorkerOptions: () => CreateWorkerOpts | undefined
  capturedRunsListOptions: () => Parameters<HatchetClient['runs']['list']>[0]
  workerCallCount: () => number
}

// One stub covering task, durableTask, worker and runs.list: subscribe,
// durable, worker and runs.forEnvelope each reach a different engine method
// through the same client.
function fakeHatchetClient(): FakeHatchetClient {
  let taskOptions: CreateTaskWorkflowOpts | undefined
  let durableOptions: CreateDurableTaskWorkflowOpts<JsonObject, void> | undefined
  let workerOptions: CreateWorkerOpts | undefined
  let runsListOptions: Parameters<HatchetClient['runs']['list']>[0]
  let workerCalls = 0
  const runs: Pick<HatchetClient['runs'], 'list'> = {
    list: (options) => {
      runsListOptions = options
      return Promise.resolve({ pagination: {}, rows: [] })
    },
  }
  const stub: Pick<HatchetClient, 'config' | 'durableTask' | 'task' | 'worker'> = {
    task: (options: CreateTaskWorkflowOpts) => {
      taskOptions = options
      return {} as TaskWorkflowDeclaration
    },
    durableTask: (options: CreateDurableTaskWorkflowOpts<JsonObject, void>) => {
      durableOptions = options
      return {} as TaskWorkflowDeclaration
    },
    worker: (_name: string, options?: CreateWorkerOpts) => {
      workerCalls += 1
      workerOptions = options
      return Promise.resolve(fakeWorker())
    },
    config: { namespace: 'shop_' } as HatchetClient['config'],
  }
  return {
    client: { ...stub, runs } as HatchetClient,
    capturedTaskOptions: () => taskOptions,
    capturedDurableOptions: () => durableOptions,
    capturedWorkerOptions: () => workerOptions,
    capturedRunsListOptions: () => runsListOptions,
    workerCallCount: () => workerCalls,
  }
}

interface FakeBulkPushResponse {
  events: object[]
}

// Mirrors relay/relay.test.ts's own fixture: a concrete procedure type keeps
// every mock call checked against `bulkPush`'s real shape.
type BulkPushProcedure = (name: string, items: PushItem[]) => Promise<FakeBulkPushResponse>

function fakeEvents(bulkPush: Mock<BulkPushProcedure>): HatchetClient['events'] {
  return { bulkPush: bulkPush as HatchetClient['events']['bulkPush'] } as HatchetClient['events']
}

function claimedRow(): OutboxRow {
  const id = '018f0000-0000-7000-8000-0000000000aa'
  return outboxRowSchema.parse({
    id,
    name: 'shop.order.placed',
    tenant_id: null,
    envelope: {
      id,
      name: 'shop.order.placed',
      version: 1,
      kind: 'event',
      occurredAt: '2026-01-01T00:00:00.000Z',
      tenantId: null,
      correlationId: id,
      source: 'shop-service',
      data: {},
    },
    created_at: new Date(),
    claimed_at: new Date(),
    claimed_by: 'worker-1',
    published_at: null,
    attempts: 0,
    last_error: null,
  })
}

// Returns the one claimed row for the relay's claim query, a no-op for
// everything else — same convention as relay/relay.test.ts's createFakeDb.
function fakeRelayDb(row: OutboxRow): Queryable {
  return {
    query(text: string, _params: readonly QueryParam[]): Promise<QueryRows> {
      if (text.includes('RETURNING *')) return Promise.resolve({ rows: [row], rowCount: 1 })
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
  }
}

describe('createQtaxis', () => {
  it('returns every member', () => {
    const { client } = fakeHatchetClient()
    const qtaxis = createQtaxis({ hatchet: client, source: 'shop-service' })

    expect(Object.keys(qtaxis).sort()).toEqual(
      ['durable', 'onceById', 'publish', 'runs', 'startRelay', 'subscribe', 'worker'].sort(),
    )
  })

  it('publish uses the given source', async () => {
    const { client } = fakeHatchetClient()
    const qtaxis = createQtaxis({ hatchet: client, source: 'shop-service' })
    const db: Queryable = {
      query(_text: string, _params: readonly QueryParam[]): Promise<QueryRows> {
        return Promise.resolve({ rows: [], rowCount: 1 })
      },
    }

    const envelope = await qtaxis.publish(
      db,
      orderPlaced,
      { orderId: '018f0000-0000-7000-8000-000000000002' },
      {
        tenantId: null,
      },
    )

    expect(envelope.source).toBe('shop-service')
  })

  it('subscribe forwards to the underlying function with the bound client', () => {
    const { client, capturedTaskOptions } = fakeHatchetClient()
    const qtaxis = createQtaxis({ hatchet: client, source: 'shop-service' })

    const subscription = qtaxis.subscribe(orderPlaced, { name: 'invoice-recorder', handler: () => undefined })

    expect(subscription).toEqual({
      name: 'invoice-recorder',
      kind: 'event',
      messageName: 'shop.order.placed',
      workflow: {},
    })
    expect(capturedTaskOptions()?.name).toBe('invoice-recorder')
    expect(capturedTaskOptions()?.onEvents).toEqual(['shop.order.placed'])
  })

  it('durable forwards to the underlying function with the bound client', () => {
    const { client, capturedDurableOptions } = fakeHatchetClient()
    const qtaxis = createQtaxis({ hatchet: client, source: 'shop-service' })

    qtaxis.durable(orderPlaced, { name: 'follow-up', handler: () => undefined })

    expect(capturedDurableOptions()?.name).toBe('follow-up')
    expect(capturedDurableOptions()?.onEvents).toEqual(['shop.order.placed'])
  })

  it('runs.forEnvelope forwards to the underlying function with the bound client', async () => {
    const { client, capturedRunsListOptions } = fakeHatchetClient()
    const qtaxis = createQtaxis({ hatchet: client, source: 'shop-service' })
    const envelopeId = uuidv7()

    const outcomes = await qtaxis.runs.forEnvelope(envelopeId)

    expect(outcomes).toEqual([])
    expect(capturedRunsListOptions()?.additionalMetadata).toEqual({ envelopeId })
  })

  it('worker forwards to the underlying function with the bound client', async () => {
    const { client, capturedWorkerOptions, workerCallCount } = fakeHatchetClient()
    const qtaxis = createQtaxis({ hatchet: client, source: 'shop-service' })
    const subscription = qtaxis.subscribe(orderPlaced, { name: 'invoice-recorder', handler: () => undefined })

    await qtaxis.worker('shop-worker', { subscriptions: [subscription] })

    expect(workerCallCount()).toBe(1)
    expect(capturedWorkerOptions()?.workflows).toEqual([subscription.workflow])
  })
})

describe('createQtaxis: startRelay', () => {
  it('binds startRelay to the same hatchet client given to createQtaxis', async () => {
    const bulkPush = vi.fn<BulkPushProcedure>(async (_name, items) => ({ events: items.map(() => ({})) }))
    const hatchet = { events: fakeEvents(bulkPush) } as HatchetClient
    const qtaxis = createQtaxis({ hatchet, source: 'shop-service' })
    const db = fakeRelayDb(claimedRow())

    const relay = qtaxis.startRelay({ db, workerId: 'worker-1', pollIntervalMs: 60_000 })
    try {
      await relay.tick()
      expect(bulkPush).toHaveBeenCalledTimes(1)
    } finally {
      await relay.stop()
    }
  })

  it('never pushes through a second engine client passed inside the options', async () => {
    const boundBulkPush = vi.fn<BulkPushProcedure>(async (_name, items) => ({ events: items.map(() => ({})) }))
    const bound = { events: fakeEvents(boundBulkPush) } as HatchetClient
    const otherBulkPush = vi.fn<BulkPushProcedure>(async (_name, items) => ({ events: items.map(() => ({})) }))
    const other = { events: fakeEvents(otherBulkPush) } as HatchetClient
    const qtaxis = createQtaxis({ hatchet: bound, source: 'shop-service' })
    const db = fakeRelayDb(claimedRow())

    // Stands in for a caller holding a value already typed `RelayOptions`
    // (which carries `hatchet`) — the case `hatchet?: never` rejects at the
    // type boundary, so the cast forces it through to prove the runtime is
    // also safe.
    const relayOptions = {
      db,
      workerId: 'worker-1',
      pollIntervalMs: 60_000,
      hatchet: other,
    } as QtaxisRelayOptions

    const relay = qtaxis.startRelay(relayOptions)
    try {
      await relay.tick()
      expect(boundBulkPush).toHaveBeenCalledTimes(1)
      expect(otherBulkPush).not.toHaveBeenCalled()
    } finally {
      await relay.stop()
    }
  })
})
