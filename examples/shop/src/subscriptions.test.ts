import type { HatchetClient, Qtaxis } from '@qtaxis/sdk'
import { CommandHasTwoSubscribersError, createQtaxis } from '@qtaxis/sdk'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import type { ShopConfig } from './config.js'
import { sendInvoiceSubscription } from './handlers/sendInvoice.js'
import { buildSubscriptions } from './subscriptions.js'

// task()/worker()/durableTask() are never given real work here:
// assertSingleCommandSubscriber throws before createWorker touches the
// client, and buildSubscriptions never calls worker() at all. A single
// indexed-type cast per method — the same unchained-cast idiom
// packages/sdk/src/createQtaxis.test.ts uses for its own fakeHatchetClient
// — since CreateTaskWorkflowOpts/CreateWorkerOpts are the engine SDK's own
// types and are not part of @qtaxis/sdk's public exports.
function fakeHatchetClient(): HatchetClient {
  const stub: Pick<HatchetClient, 'task' | 'durableTask' | 'worker'> = {
    task: (_options: Parameters<HatchetClient['task']>[0]) => ({}) as ReturnType<HatchetClient['task']>,
    durableTask: (_options: Parameters<HatchetClient['durableTask']>[0]) =>
      ({}) as ReturnType<HatchetClient['durableTask']>,
    worker: (_name: string) => new Promise<never>(() => undefined),
  }
  return stub as HatchetClient
}

function fakePool(): Pool {
  const stub: Pick<Pool, 'connect'> = { connect: (() => new Promise<never>(() => undefined)) as Pool['connect'] }
  return stub as Pool
}

function buildQtaxis(): Qtaxis {
  return createQtaxis({ hatchet: fakeHatchetClient(), source: 'subscriptions-test' })
}

function fakeConfig(): ShopConfig {
  return {
    databaseUrl: 'postgresql://localhost/fake',
    namespace: 'test_',
    logLevel: 'info',
    watchShippingTimeout: '3m',
    uiPort: 3333,
  }
}

describe('buildSubscriptions', () => {
  it('registers record-order, audit-order, send-invoice and watch-shipping', () => {
    const subscriptions = buildSubscriptions(buildQtaxis(), fakePool(), fakeConfig())

    expect(subscriptions.map((subscription) => subscription.name)).toEqual([
      'record-order',
      'audit-order',
      'send-invoice',
      'watch-shipping',
    ])
  })
})

describe('createWorker via qtaxis.worker', () => {
  it('throws CommandHasTwoSubscribersError when a command is subscribed twice', async () => {
    const qtaxis = buildQtaxis()
    const pool = fakePool()
    const config = fakeConfig()
    const subscriptions = [...buildSubscriptions(qtaxis, pool, config), sendInvoiceSubscription(qtaxis, pool)]

    await expect(qtaxis.worker('duplicate-worker', { subscriptions })).rejects.toBeInstanceOf(
      CommandHasTwoSubscribersError,
    )
  })
})
