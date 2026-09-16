import { describe, expect, it } from 'vitest'
import { CommandHasTwoSubscribersError } from '../errors.js'
import { assertSingleCommandSubscriber } from './worker.js'
import type { Subscription } from './subscribe.js'

function stubSubscription(name: string, kind: Subscription['kind'], messageName: string): Subscription {
  // The workflow field is never read by assertSingleCommandSubscriber; a
  // stub keeps this unit test free of the engine.
  return { name, kind, messageName, workflow: {} as Subscription['workflow'] }
}

describe('assertSingleCommandSubscriber', () => {
  it('refuses two subscriptions to the same command name', () => {
    const subscriptions = [
      stubSubscription('send-invoice', 'command', 'shop.invoice.send'),
      stubSubscription('send-invoice-again', 'command', 'shop.invoice.send'),
    ]

    expect(() => assertSingleCommandSubscriber(subscriptions)).toThrow(CommandHasTwoSubscribersError)
  })

  it('allows two subscriptions to the same event name', () => {
    const subscriptions = [
      stubSubscription('notify-ops', 'event', 'shop.order.placed'),
      stubSubscription('notify-billing', 'event', 'shop.order.placed'),
    ]

    expect(() => assertSingleCommandSubscriber(subscriptions)).not.toThrow()
  })

  it('allows a single command subscriber', () => {
    const subscriptions = [stubSubscription('send-invoice', 'command', 'shop.invoice.send')]

    expect(() => assertSingleCommandSubscriber(subscriptions)).not.toThrow()
  })
})
