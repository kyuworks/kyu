import type { HandlerContext, Kyu, MessageData, Subscription } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { withTransaction } from '../db/pool.js'
import { orderPlaced } from '../messages.js'
import { writeHandlerLogRow } from './handlerLog.js'
import { requireTenant } from './tenant.js'

type OrderPlacedContext = HandlerContext<MessageData<typeof orderPlaced>>

async function recordOrder(pool: Pool, kyu: Kyu, ctx: OrderPlacedContext): Promise<void> {
  const tenantId = requireTenant('record-order', ctx)
  const { orderId } = ctx.envelope.data

  await withTransaction(pool, (tx) =>
    kyu.onceById(tx, ctx.envelope.id, 'record-order', async () => {
      await tx.query('UPDATE shop_order SET recorded_at = now() WHERE id = $1', [orderId])
      await writeHandlerLogRow(tx, { handler: 'record-order', envelopeId: ctx.envelope.id, orderId, tenantId })
    }),
  )
}

export function recordOrderSubscription(kyu: Kyu, pool: Pool): Subscription {
  return kyu.subscribe(orderPlaced, {
    name: 'record-order',
    handler: (ctx) => recordOrder(pool, kyu, ctx),
  })
}
