import type { Qtaxis, Subscription } from '@qtaxis/sdk'
import type { Pool } from 'pg'
import type { PlaygroundConfig } from './config.js'
import { auditOrderSubscription } from './handlers/auditOrder.js'
import { recordOrderSubscription } from './handlers/recordOrder.js'
import { sendInvoiceSubscription } from './handlers/sendInvoice.js'
import { watchShippingSubscription } from './handlers/watchShipping.js'

/** One registry the worker and the unit test share. */
export function buildSubscriptions(qtaxis: Qtaxis, pool: Pool, config: PlaygroundConfig): Subscription[] {
  return [
    recordOrderSubscription(qtaxis, pool),
    auditOrderSubscription(qtaxis, pool),
    sendInvoiceSubscription(qtaxis, pool),
    watchShippingSubscription(qtaxis, pool, config),
  ]
}
