import type { Subscription } from '@qtaxis/sdk'
import { WATCH_SHIPPING_COMPLETED, WATCH_SHIPPING_TIMEOUT, WATCH_SHIPPING_WAITING } from '../handlers/watchShipping.js'
import { PLAYGROUND_SOURCE } from '../qtaxis.js'

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

// watch-shipping finishes under two handler names instead of one; every
// other subscription finishes in one row under its own name.
const HANDLER_OVERRIDES = new Map<string, HandlerOverride>([
  [
    'watch-shipping',
    { doneHandlers: [WATCH_SHIPPING_COMPLETED, WATCH_SHIPPING_TIMEOUT], waitingHandler: WATCH_SHIPPING_WAITING },
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
