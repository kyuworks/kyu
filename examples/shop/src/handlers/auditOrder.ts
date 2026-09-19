import type { HandlerContext, Qtaxis, MessageData, Subscription } from '@qtaxis/sdk'
import type { Pool } from 'pg'
import { withTransaction } from '../db/pool.js'
import { orderPlaced } from '../messages.js'
import { requireTenant } from './tenant.js'

type OrderPlacedContext = HandlerContext<MessageData<typeof orderPlaced>>

// A second subscriber on the same event (fan-out); onceById absorbs a
// redelivery the same way record-order does, so the unique log index never fails a retry.
async function auditOrder(pool: Pool, qtaxis: Qtaxis, ctx: OrderPlacedContext): Promise<void> {
  const tenantId = requireTenant('audit-order', ctx)

  await withTransaction(pool, (tx) =>
    qtaxis.onceById(tx, ctx.envelope.id, 'audit-order', () =>
      tx.query(
        'INSERT INTO shop_handler_log (handler, envelope_id, order_id, tenant_id, pid) VALUES ($1, $2, $3, $4, $5)',
        ['audit-order', ctx.envelope.id, ctx.envelope.data.orderId, tenantId, process.pid],
      ),
    ),
  )
}

export function auditOrderSubscription(qtaxis: Qtaxis, pool: Pool): Subscription {
  return qtaxis.subscribe(orderPlaced, {
    name: 'audit-order',
    handler: (ctx) => auditOrder(pool, qtaxis, ctx),
  })
}
