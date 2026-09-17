import type { HandlerContext, Kinesin, MessageData, Subscription } from '@kinesin/sdk'
import { NonRetryableError } from '@kinesin/sdk'
import type { Pool } from 'pg'
import { withTransaction } from '../db/pool.js'
import { orderPlaced } from '../messages.js'

type OrderPlacedContext = HandlerContext<MessageData<typeof orderPlaced>>

async function recordOrder(pool: Pool, kinesin: Kinesin, ctx: OrderPlacedContext): Promise<void> {
  const { tenantId } = ctx.envelope
  // Every shop.* message is tenant-scoped (AGENTS.md non-goals); a null
  // tenantId means a message this app never publishes reached the handler.
  if (tenantId === null) throw new NonRetryableError(`record-order: envelope ${ctx.envelope.id} has no tenantId`)

  await withTransaction(pool, (tx) =>
    kinesin.onceById(tx, ctx.envelope.id, 'record-order', async () => {
      await tx.query('UPDATE shop_order SET recorded_at = now() WHERE id = $1', [ctx.envelope.data.orderId])
      await tx.query(
        'INSERT INTO shop_handler_log (handler, envelope_id, order_id, tenant_id, pid) VALUES ($1, $2, $3, $4, $5)',
        ['record-order', ctx.envelope.id, ctx.envelope.data.orderId, tenantId, process.pid],
      )
    }),
  )
}

export function recordOrderSubscription(kinesin: Kinesin, pool: Pool): Subscription {
  return kinesin.subscribe(orderPlaced, {
    name: 'record-order',
    handler: (ctx) => recordOrder(pool, kinesin, ctx),
  })
}
