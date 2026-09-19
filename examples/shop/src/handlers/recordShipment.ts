import type { HandlerContext, Kyu, MessageData, Subscription } from '@kyuworks/sdk'
import { NonRetryableError } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { withTransaction } from '../db/pool.js'
import { orderShipped } from '../messages.js'
import { requireTenant } from './tenant.js'

type OrderShippedContext = HandlerContext<MessageData<typeof orderShipped>>

// This is the only writer of shop_order.shipped_at; watch-shipping observes
// the same event and records its own outcome, not this column.
// Exported so the unit test can drive it directly against a fake pool,
// without reaching into the opaque Hatchet workflow subscribe() builds.
export async function handleRecordShipment(pool: Pool, kyu: Kyu, ctx: OrderShippedContext): Promise<void> {
  const tenantId = requireTenant('record-shipment', ctx)
  const { orderId, carrier } = ctx.envelope.data

  await withTransaction(pool, (tx) =>
    kyu.onceById(tx, ctx.envelope.id, 'record-shipment', async () => {
      // coalesce, not `WHERE shipped_at IS NULL`: a zero-row result then means
      // "no such order for this tenant", never "already shipped".
      const updated = await tx.query(
        'UPDATE shop_order SET shipped_at = coalesce(shipped_at, $2::timestamptz) WHERE id = $1 AND tenant_id = $3 RETURNING id',
        [orderId, ctx.envelope.occurredAt, tenantId],
      )
      if (updated.rows.length === 0) {
        throw new NonRetryableError(`record-shipment: no shop_order row for order ${orderId} in tenant ${tenantId}`)
      }
      await tx.query(
        'INSERT INTO shop_handler_log (handler, envelope_id, order_id, tenant_id, pid, note) VALUES ($1, $2, $3, $4, $5, $6)',
        ['record-shipment', ctx.envelope.id, orderId, tenantId, process.pid, carrier],
      )
    }),
  )
}

export function recordShipmentSubscription(kyu: Kyu, pool: Pool): Subscription {
  return kyu.subscribe(orderShipped, {
    name: 'record-shipment',
    concurrency: { key: 'input.data.orderId', maxRuns: 1, strategy: 'fifo' },
    handler: (ctx) => handleRecordShipment(pool, kyu, ctx),
  })
}
