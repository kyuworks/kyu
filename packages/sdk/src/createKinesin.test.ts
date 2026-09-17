import { defineEvent } from '@kinesin/schemas'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createKinesin } from './createKinesin.js'
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
  workerCallCount: () => number
}

// One stub covering task, durableTask and worker: createKinesin's own
// subscribe, durable and worker members each reach a different engine
// method, all through the one client createKinesin was given.
function fakeHatchetClient(): FakeHatchetClient {
  let taskOptions: CreateTaskWorkflowOpts | undefined
  let durableOptions: CreateDurableTaskWorkflowOpts<JsonObject, void> | undefined
  let workerOptions: CreateWorkerOpts | undefined
  let workerCalls = 0
  const stub: Pick<HatchetClient, 'durableTask' | 'task' | 'worker'> = {
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
  }
  return {
    client: stub as HatchetClient,
    capturedTaskOptions: () => taskOptions,
    capturedDurableOptions: () => durableOptions,
    capturedWorkerOptions: () => workerOptions,
    workerCallCount: () => workerCalls,
  }
}

describe('createKinesin', () => {
  it('returns every member', () => {
    const { client } = fakeHatchetClient()
    const kinesin = createKinesin({ hatchet: client, source: 'shop-service' })

    expect(Object.keys(kinesin).sort()).toEqual(
      ['durable', 'onceById', 'publish', 'publishEnvelope', 'startRelay', 'subscribe', 'worker'].sort(),
    )
  })

  it('publish uses the given source', async () => {
    const { client } = fakeHatchetClient()
    const kinesin = createKinesin({ hatchet: client, source: 'shop-service' })
    const db: Queryable = {
      query(_text: string, _params: readonly QueryParam[]): Promise<QueryRows> {
        return Promise.resolve({ rows: [], rowCount: 1 })
      },
    }

    const envelope = await kinesin.publish(
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
    const kinesin = createKinesin({ hatchet: client, source: 'shop-service' })

    const subscription = kinesin.subscribe(orderPlaced, { name: 'invoice-recorder', handler: () => undefined })

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
    const kinesin = createKinesin({ hatchet: client, source: 'shop-service' })

    kinesin.durable(orderPlaced, { name: 'follow-up', handler: () => undefined })

    expect(capturedDurableOptions()?.name).toBe('follow-up')
    expect(capturedDurableOptions()?.onEvents).toEqual(['shop.order.placed'])
  })

  it('worker forwards to the underlying function with the bound client', async () => {
    const { client, capturedWorkerOptions, workerCallCount } = fakeHatchetClient()
    const kinesin = createKinesin({ hatchet: client, source: 'shop-service' })
    const subscription = kinesin.subscribe(orderPlaced, { name: 'invoice-recorder', handler: () => undefined })

    await kinesin.worker('shop-worker', { subscriptions: [subscription] })

    expect(workerCallCount()).toBe(1)
    expect(capturedWorkerOptions()?.workflows).toEqual([subscription.workflow])
  })
})
