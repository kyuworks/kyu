import type { HatchetClient, Kinesin } from '@kinesin/sdk'
import { createKinesin } from '@kinesin/sdk'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import type { PlaygroundConfig } from '../config.js'
import { buildSubscriptions } from '../subscriptions.js'
import { describeBusTopology } from './busTopology.js'

// Mirrors subscriptions.test.ts's fakes: buildSubscriptions never touches the
// engine client or the pool, so a real Subscription[] (name/kind/messageName)
// comes back without spinning up either.
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

function fakeConfig(): PlaygroundConfig {
  return {
    databaseUrl: 'postgresql://localhost/fake',
    namespace: 'test_',
    logLevel: 'info',
    watchShippingTimeout: '3m',
    uiPort: 3333,
  }
}

function fakeKinesin(): Kinesin {
  return createKinesin({ hatchet: fakeHatchetClient(), source: 'bus-topology-test' })
}

describe('describeBusTopology', () => {
  it('names the producer after the source every publish uses', () => {
    const subscriptions = buildSubscriptions(fakeKinesin(), fakePool(), fakeConfig())

    const topology = describeBusTopology(subscriptions)

    expect(topology.producer).toEqual({ source: 'playground' })
  })

  it('carries name, messageName and kind through unchanged for a plain subscription', () => {
    const subscriptions = buildSubscriptions(fakeKinesin(), fakePool(), fakeConfig())

    const topology = describeBusTopology(subscriptions)

    const recordOrder = topology.subscriptions.find((subscription) => subscription.name === 'record-order')
    expect(recordOrder).toEqual({
      name: 'record-order',
      messageName: 'shop.order.placed',
      kind: 'event',
      doneHandlers: ['record-order'],
    })
  })

  it('defaults doneHandlers to the subscription name with no waitingHandler', () => {
    const subscriptions = buildSubscriptions(fakeKinesin(), fakePool(), fakeConfig())

    const topology = describeBusTopology(subscriptions)

    const sendInvoice = topology.subscriptions.find((subscription) => subscription.name === 'send-invoice')
    expect(sendInvoice?.doneHandlers).toEqual(['send-invoice'])
    expect(sendInvoice?.waitingHandler).toBeUndefined()
  })

  it('overrides watch-shipping with its two finishing handlers and a waiting handler', () => {
    const subscriptions = buildSubscriptions(fakeKinesin(), fakePool(), fakeConfig())

    const topology = describeBusTopology(subscriptions)

    const watchShipping = topology.subscriptions.find((subscription) => subscription.name === 'watch-shipping')
    expect(watchShipping).toEqual({
      name: 'watch-shipping',
      messageName: 'shop.order.placed',
      kind: 'event',
      doneHandlers: ['watch-shipping:completed', 'watch-shipping:timeout'],
      waitingHandler: 'watch-shipping:waiting',
    })
  })

  it('describes every subscription the worker registers, in order', () => {
    const subscriptions = buildSubscriptions(fakeKinesin(), fakePool(), fakeConfig())

    const topology = describeBusTopology(subscriptions)

    expect(topology.subscriptions.map((subscription) => subscription.name)).toEqual([
      'record-order',
      'audit-order',
      'send-invoice',
      'watch-shipping',
    ])
  })
})
