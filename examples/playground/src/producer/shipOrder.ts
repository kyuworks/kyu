import type { Kinesin } from '@kinesin/sdk'
import type { Pool } from 'pg'
import { withTransaction } from '../db/pool.js'
import { orderShipped } from '../messages.js'

export interface ShipOrderInput {
  tenantId: string
  orderId: string
  carrier: string
}

// The handler side records `shop_order.shipped_at`; this producer only publishes.
export function shipOrder(pool: Pool, kinesin: Kinesin, input: ShipOrderInput): Promise<string> {
  return withTransaction(pool, async (client) => {
    const envelope = await kinesin.publish(
      client,
      orderShipped,
      { orderId: input.orderId, carrier: input.carrier },
      { tenantId: input.tenantId },
    )
    return envelope.id
  })
}
