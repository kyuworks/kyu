import type { HatchetClient, Qtaxis } from '@qtaxis/sdk'
import { createQtaxis } from '@qtaxis/sdk'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import type { PlaygroundConfig } from '../config.js'
import { WATCH_SHIPPING_COMPLETED, WATCH_SHIPPING_TIMEOUT, WATCH_SHIPPING_WAITING } from '../handlers/watchShipping.js'
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

function fakeQtaxis(): Qtaxis {
  return createQtaxis({ hatchet: fakeHatchetClient(), source: 'bus-topology-test' })
}

describe('describeBusTopology', () => {
  it('names the producer after the source every publish uses', () => {
    const subscriptions = buildSubscriptions(fakeQtaxis(), fakePool(), fakeConfig())

    const topology = describeBusTopology(subscriptions)

    expect(topology.producer).toEqual({ source: 'playground' })
  })

  it('carries name, messageName and kind through unchanged for a plain subscription', () => {
    const subscriptions = buildSubscriptions(fakeQtaxis(), fakePool(), fakeConfig())

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
    const subscriptions = buildSubscriptions(fakeQtaxis(), fakePool(), fakeConfig())

    const topology = describeBusTopology(subscriptions)

    const sendInvoice = topology.subscriptions.find((subscription) => subscription.name === 'send-invoice')
    expect(sendInvoice?.doneHandlers).toEqual(['send-invoice'])
    expect(sendInvoice?.waitingHandler).toBeUndefined()
  })

  it('overrides watch-shipping with its two finishing handlers and a waiting handler', () => {
    const subscriptions = buildSubscriptions(fakeQtaxis(), fakePool(), fakeConfig())

    const topology = describeBusTopology(subscriptions)

    const watchShipping = topology.subscriptions.find((subscription) => subscription.name === 'watch-shipping')
    expect(watchShipping).toEqual({
      name: 'watch-shipping',
      messageName: 'shop.order.placed',
      kind: 'event',
      doneHandlers: [WATCH_SHIPPING_COMPLETED, WATCH_SHIPPING_TIMEOUT],
      waitingHandler: WATCH_SHIPPING_WAITING,
    })
  })

  it('describes every subscription the worker registers, in order', () => {
    const subscriptions = buildSubscriptions(fakeQtaxis(), fakePool(), fakeConfig())

    const topology = describeBusTopology(subscriptions)

    expect(topology.subscriptions.map((subscription) => subscription.name)).toEqual([
      'record-order',
      'audit-order',
      'send-invoice',
      'watch-shipping',
    ])
  })

  // A plain subscription's module logs its own name; only watch-shipping
  // diverges, from watchShipping.ts's own exported constants (not a literal).
  const EXPECTED_DONE_HANDLERS = new Map<string, string[]>([
    ['watch-shipping', [WATCH_SHIPPING_COMPLETED, WATCH_SHIPPING_TIMEOUT]],
  ])

  it("ties every subscription's doneHandlers to the handler names its own module writes", () => {
    const subscriptions = buildSubscriptions(fakeQtaxis(), fakePool(), fakeConfig())

    const topology = describeBusTopology(subscriptions)

    for (const subscription of topology.subscriptions) {
      const expected = EXPECTED_DONE_HANDLERS.get(subscription.name) ?? [subscription.name]
      expect(subscription.doneHandlers).toEqual(expected)
    }
  })
})
