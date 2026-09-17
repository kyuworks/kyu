import type { Kinesin, Subscription } from '@kinesin/sdk'
import type { Pool } from 'pg'
import { auditOrderSubscription } from './handlers/auditOrder.js'
import { recordOrderSubscription } from './handlers/recordOrder.js'
import { sendInvoiceSubscription } from './handlers/sendInvoice.js'

/** One registry the worker and the unit test share. The durable subscription lands in the next PR. */
export function buildSubscriptions(kinesin: Kinesin, pool: Pool): Subscription[] {
  return [
    recordOrderSubscription(kinesin, pool),
    auditOrderSubscription(kinesin, pool),
    sendInvoiceSubscription(kinesin, pool),
  ]
}
