import type { Kinesin, Subscription } from '@kinesin/sdk'
import type { Pool } from 'pg'
import type { PlaygroundConfig } from './config.js'
import { auditOrderSubscription } from './handlers/auditOrder.js'
import { recordOrderSubscription } from './handlers/recordOrder.js'
import { sendInvoiceSubscription } from './handlers/sendInvoice.js'
import { watchShippingSubscription } from './handlers/watchShipping.js'

/** One registry the worker and the unit test share. */
export function buildSubscriptions(kinesin: Kinesin, pool: Pool, config: PlaygroundConfig): Subscription[] {
  return [
    recordOrderSubscription(kinesin, pool),
    auditOrderSubscription(kinesin, pool),
    sendInvoiceSubscription(kinesin, pool),
    watchShippingSubscription(kinesin, pool, config),
  ]
}
