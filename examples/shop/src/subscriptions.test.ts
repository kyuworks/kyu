import type { HatchetClient, Kyu } from '@kyuworks/sdk'
import { CommandHasTwoSubscribersError, createKyu } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import type { ShopConfig } from './config.js'
import { sendInvoiceSubscription } from './handlers/sendInvoice.js'
import { buildSubscriptions } from './subscriptions.js'

type CapturedTaskOptions = Parameters<HatchetClient['task']>[0]

interface FakeHatchetClient {
  client: HatchetClient
  capturedOptionsByName: () => ReadonlyMap<string, CapturedTaskOptions>
}

interface TestKyu {
  kyu: Kyu
  capturedOptionsByName: () => ReadonlyMap<string, CapturedTaskOptions>
}

// task()/worker()/durableTask() are never given real work here:
// assertSingleCommandSubscriber throws before createWorker touches the
// client, and buildSubscriptions never calls worker() at all. A single
// indexed-type cast per method — the same unchained-cast idiom
// packages/sdk/src/createKyu.test.ts uses for its own fakeHatchetClient
// — since CreateTaskWorkflowOpts/CreateWorkerOpts are the engine SDK's own
// types and are not part of @kyuworks/sdk's public exports.
// task/durableTask capture the options they were called with, keyed by
// subscription name, so a test can inspect what a subscription sent the engine.
function fakeHatchetClient(): FakeHatchetClient {
  const captured = new Map<string, CapturedTaskOptions>()
  const stub: Pick<HatchetClient, 'task' | 'durableTask' | 'worker'> = {
    task: (options: CapturedTaskOptions) => {
      captured.set(options.name, options)
      return {} as ReturnType<HatchetClient['task']>
    },
    durableTask: (options: Parameters<HatchetClient['durableTask']>[0]) => {
      captured.set(options.name, options)
      return {} as ReturnType<HatchetClient['durableTask']>
    },
    worker: (_name: string) => new Promise<never>(() => undefined),
  }
  return { client: stub as HatchetClient, capturedOptionsByName: () => captured }
}

function fakePool(): Pool {
  const stub: Pick<Pool, 'connect'> = { connect: (() => new Promise<never>(() => undefined)) as Pool['connect'] }
  return stub as Pool
}

function buildKyu(): TestKyu {
  const { client, capturedOptionsByName } = fakeHatchetClient()
  return { kyu: createKyu({ hatchet: client, source: 'subscriptions-test' }), capturedOptionsByName }
}

function fakeConfig(): ShopConfig {
  return {
    databaseUrl: 'postgresql://localhost/fake',
    namespace: 'test_',
    logLevel: 'info',
    watchShippingTimeout: '3m',
    uiPort: 3333,
    workerSlots: 5,
    workerDurableSlots: 5,
  }
}

describe('buildSubscriptions', () => {
  it('registers record-order, audit-order, send-invoice, watch-shipping, record-shipment, run-workflow and notify-staff', () => {
    const { kyu } = buildKyu()
    const subscriptions = buildSubscriptions(kyu, fakePool(), fakeConfig())

    expect(subscriptions.map((subscription) => subscription.name)).toEqual([
      'record-order',
      'audit-order',
      'send-invoice',
      'watch-shipping',
      'record-shipment',
      'run-workflow',
      'notify-staff',
    ])
  })

  // Sized above the harness's tenant-load window (issue #149): the engine's
  // own default schedule timeout is 5 minutes, too short for this load.
  it.each(['record-order', 'audit-order', 'send-invoice', 'watch-shipping', 'run-workflow'])(
    'sets scheduleTimeout to 30m on %s',
    (name) => {
      const { kyu, capturedOptionsByName } = buildKyu()
      buildSubscriptions(kyu, fakePool(), fakeConfig())

      expect(capturedOptionsByName().get(name)?.scheduleTimeout).toBe('30m')
    },
  )
})

describe('createWorker via kyu.worker', () => {
  it('throws CommandHasTwoSubscribersError when a command is subscribed twice', async () => {
    const { kyu } = buildKyu()
    const pool = fakePool()
    const config = fakeConfig()
    const subscriptions = [...buildSubscriptions(kyu, pool, config), sendInvoiceSubscription(kyu, pool)]

    await expect(kyu.worker('duplicate-worker', { subscriptions })).rejects.toBeInstanceOf(
      CommandHasTwoSubscribersError,
    )
  })
})
