import type { HandlerContext, Kyu, MessageData, Subscription } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { withTransaction } from '../db/pool.js'
import { orderPlaced } from '../messages.js'
import { requireTenant } from './tenant.js'

type OrderPlacedContext = HandlerContext<MessageData<typeof orderPlaced>>

async function recordOrder(pool: Pool, kyu: Kyu, ctx: OrderPlacedContext): Promise<void> {
  const tenantId = requireTenant('record-order', ctx)

  await withTransaction(pool, (tx) =>
    kyu.onceById(tx, ctx.envelope.id, 'record-order', async () => {
      await tx.query('UPDATE shop_order SET recorded_at = now() WHERE id = $1', [ctx.envelope.data.orderId])
      await tx.query(
        'INSERT INTO shop_handler_log (handler, envelope_id, order_id, tenant_id, pid) VALUES ($1, $2, $3, $4, $5)',
        ['record-order', ctx.envelope.id, ctx.envelope.data.orderId, tenantId, process.pid],
      )
    }),
  )
}

export function recordOrderSubscription(kyu: Kyu, pool: Pool): Subscription {
  return kyu.subscribe(orderPlaced, {
    name: 'record-order',
    handler: (ctx) => recordOrder(pool, kyu, ctx),
  })
}
