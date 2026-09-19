import type { Kyu } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { withTransaction } from '../db/pool.js'
import { orderShipped } from '../messages.js'

export interface ShipOrderInput {
  tenantId: string
  orderId: string
  carrier: string
}

// The handler side records `shop_order.shipped_at`; this producer only publishes.
export function shipOrder(pool: Pool, kyu: Kyu, input: ShipOrderInput): Promise<string> {
  return withTransaction(pool, async (client) => {
    const envelope = await kyu.publish(
      client,
      orderShipped,
      { orderId: input.orderId, carrier: input.carrier },
      { tenantId: input.tenantId },
    )
    return envelope.id
  })
}
