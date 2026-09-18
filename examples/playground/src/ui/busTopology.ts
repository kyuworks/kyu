import type { Subscription } from '@kinesin/sdk'
import { PLAYGROUND_SOURCE } from '../kinesin.js'

export interface TopologySubscription {
  name: string
  messageName: string
  kind: Subscription['kind']
  doneHandlers: string[]
  waitingHandler?: string
}

export interface BusTopology {
  producer: { source: string }
  subscriptions: TopologySubscription[]
}

interface HandlerOverride {
  doneHandlers: string[]
  waitingHandler: string
}

// watch-shipping's durable body (handlers/watchShipping.ts) writes a waiting
// row before its wait and a completed/timeout row after it, under two
// different shop_handler_log handler names; every other subscription
// finishes in one row under its own name.
const HANDLER_OVERRIDES = new Map<string, HandlerOverride>([
  [
    'watch-shipping',
    {
      doneHandlers: ['watch-shipping:completed', 'watch-shipping:timeout'],
      waitingHandler: 'watch-shipping:waiting',
    },
  ],
])

function describeSubscription(subscription: Subscription): TopologySubscription {
  const override = HANDLER_OVERRIDES.get(subscription.name)
  const described: TopologySubscription = {
    name: subscription.name,
    messageName: subscription.messageName,
    kind: subscription.kind,
    doneHandlers: override?.doneHandlers ?? [subscription.name],
  }
  if (override !== undefined) described.waitingHandler = override.waitingHandler
  return described
}

/** The bus diagram's shape: the producer box and one entry per subscription, arrows labelled by message name. */
export function describeBusTopology(subscriptions: readonly Subscription[]): BusTopology {
  return {
    producer: { source: PLAYGROUND_SOURCE },
    subscriptions: subscriptions.map(describeSubscription),
  }
}
