import type { Subscription } from '@qtaxis/sdk'
import { WATCH_SHIPPING_COMPLETED, WATCH_SHIPPING_TIMEOUT, WATCH_SHIPPING_WAITING } from '../handlers/watchShipping.js'
import { orderShipped } from '../messages.js'
import { PLAYGROUND_SOURCE } from '../qtaxis.js'

/** One way a subscription can finish, under the handler name it writes to shop_handler_log. */
export interface TopologyDoneOutcome {
  handler: string
  label: string
}

/** A second message that wakes a parked run of this subscription. */
export interface TopologyWake {
  messageName: string
  label: string
}

export interface TopologySubscription {
  name: string
  messageName: string
  kind: Subscription['kind']
  /** Only when "done" splits into named domain outcomes this handler logs itself. */
  doneOutcomes?: TopologyDoneOutcome[]
  /** Only when the handler parks in a wait and logs a row before it. */
  waitingHandler?: string
  /** Only when a correlated message wakes a parked run; a durable waitFor is invisible on Subscription. */
  wakesOn?: TopologyWake
}

export interface BusTopology {
  producer: { source: string }
  subscriptions: TopologySubscription[]
}

interface HandlerOverride {
  doneOutcomes: TopologyDoneOutcome[]
  waitingHandler: string
  wakesOn: TopologyWake
}

// watch-shipping parks in a wait and finishes under two handler names; every
// other subscription's engine "completed" is the whole story for it.
const HANDLER_OVERRIDES = new Map<string, HandlerOverride>([
  [
    'watch-shipping',
    {
      doneOutcomes: [
        { handler: WATCH_SHIPPING_COMPLETED, label: 'shipped' },
        { handler: WATCH_SHIPPING_TIMEOUT, label: 'timed out' },
      ],
      waitingHandler: WATCH_SHIPPING_WAITING,
      wakesOn: { messageName: orderShipped.name, label: `${orderShipped.name} wakes a parked run` },
    },
  ],
])

function describeSubscription(subscription: Subscription): TopologySubscription {
  const override = HANDLER_OVERRIDES.get(subscription.name)
  const described: TopologySubscription = {
    name: subscription.name,
    messageName: subscription.messageName,
    kind: subscription.kind,
  }
  if (override !== undefined) {
    described.doneOutcomes = override.doneOutcomes
    described.waitingHandler = override.waitingHandler
    described.wakesOn = override.wakesOn
  }
  return described
}

/** The bus diagram's shape: the producer box and one entry per subscription, arrows labelled by message name. */
export function describeBusTopology(subscriptions: readonly Subscription[]): BusTopology {
  return {
    producer: { source: PLAYGROUND_SOURCE },
    subscriptions: subscriptions.map(describeSubscription),
  }
}
