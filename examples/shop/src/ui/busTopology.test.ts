import type { HatchetClient, Qtaxis } from '@qtaxis/sdk'
import { createQtaxis } from '@qtaxis/sdk'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import type { ShopConfig } from '../config.js'
import {
  WATCH_SHIPPING_COMPLETED,
  WATCH_SHIPPING_NAME,
  WATCH_SHIPPING_TIMEOUT,
  WATCH_SHIPPING_WAITING,
} from '../handlers/watchShipping.js'
import { orderShipped } from '../messages.js'
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

function fakeConfig(): ShopConfig {
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

    expect(topology.producer).toEqual({ source: 'shop' })
  })

  it('carries name, messageName and kind through unchanged for a plain subscription', () => {
    const subscriptions = buildSubscriptions(fakeQtaxis(), fakePool(), fakeConfig())

    const topology = describeBusTopology(subscriptions)

    const recordOrder = topology.subscriptions.find((subscription) => subscription.name === 'record-order')
    expect(recordOrder).toEqual({ name: 'record-order', messageName: 'shop.order.placed', kind: 'event' })
  })

  it('gives a plain subscription no doneOutcomes, waitingHandler or wakesOn', () => {
    const subscriptions = buildSubscriptions(fakeQtaxis(), fakePool(), fakeConfig())

    const topology = describeBusTopology(subscriptions)

    const sendInvoice = topology.subscriptions.find((subscription) => subscription.name === 'send-invoice')
    expect(sendInvoice?.doneOutcomes).toBeUndefined()
    expect(sendInvoice?.waitingHandler).toBeUndefined()
    expect(sendInvoice?.wakesOn).toBeUndefined()
  })

  it('overrides watch-shipping with its done outcomes, waiting handler and wake message', () => {
    const subscriptions = buildSubscriptions(fakeQtaxis(), fakePool(), fakeConfig())

    const topology = describeBusTopology(subscriptions)

    const watchShipping = topology.subscriptions.find((subscription) => subscription.name === WATCH_SHIPPING_NAME)
    expect(watchShipping).toEqual({
      name: WATCH_SHIPPING_NAME,
      messageName: 'shop.order.placed',
      kind: 'event',
      doneOutcomes: [
        { handler: WATCH_SHIPPING_COMPLETED, label: 'shipped' },
        { handler: WATCH_SHIPPING_TIMEOUT, label: 'timed out' },
      ],
      waitingHandler: WATCH_SHIPPING_WAITING,
      wakesOn: { messageName: orderShipped.name, label: `${orderShipped.name} wakes a parked run` },
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

  // Only watch-shipping's own module names drive its optional fields; every
  // other subscription carries none of them.
  it("ties watch-shipping's optional fields to the handler names its own module writes, and no other subscription", () => {
    const subscriptions = buildSubscriptions(fakeQtaxis(), fakePool(), fakeConfig())

    const topology = describeBusTopology(subscriptions)

    for (const subscription of topology.subscriptions) {
      if (subscription.name === WATCH_SHIPPING_NAME) {
        expect(subscription.doneOutcomes?.map((outcome) => outcome.handler)).toEqual([
          WATCH_SHIPPING_COMPLETED,
          WATCH_SHIPPING_TIMEOUT,
        ])
        expect(subscription.waitingHandler).toBe(WATCH_SHIPPING_WAITING)
      } else {
        expect(subscription.doneOutcomes).toBeUndefined()
        expect(subscription.waitingHandler).toBeUndefined()
        expect(subscription.wakesOn).toBeUndefined()
      }
    }
  })
})
