import type { Kyu, Subscription } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import type { ShopConfig } from './config.js'
import { auditOrderSubscription } from './handlers/auditOrder.js'
import { recordOrderSubscription } from './handlers/recordOrder.js'
import { recordShipmentSubscription } from './handlers/recordShipment.js'
import { sendInvoiceSubscription } from './handlers/sendInvoice.js'
import { watchShippingSubscription } from './handlers/watchShipping.js'

/** One registry the worker and the unit test share. */
export function buildSubscriptions(kyu: Kyu, pool: Pool, config: ShopConfig): Subscription[] {
  return [
    recordOrderSubscription(kyu, pool),
    auditOrderSubscription(kyu, pool),
    sendInvoiceSubscription(kyu, pool),
    watchShippingSubscription(kyu, pool, config),
    recordShipmentSubscription(kyu, pool),
  ]
}
