import type { HandlerContext, Kyu, MessageData, Subscription } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { withTransaction } from '../db/pool.js'
import { orderPlaced } from '../messages.js'
import { writeHandlerLogRow } from './handlerLog.js'
import { requireTenant } from './tenant.js'

type OrderPlacedContext = HandlerContext<MessageData<typeof orderPlaced>>

// A second subscriber on the same event (fan-out); onceById absorbs a
// redelivery the same way record-order does, so the unique log index never fails a retry.
async function auditOrder(pool: Pool, kyu: Kyu, ctx: OrderPlacedContext): Promise<void> {
  const tenantId = requireTenant('audit-order', ctx)
  const { orderId } = ctx.envelope.data

  await withTransaction(pool, (tx) =>
    kyu.onceById(tx, ctx.envelope.id, 'audit-order', () =>
      writeHandlerLogRow(tx, { handler: 'audit-order', envelopeId: ctx.envelope.id, orderId, tenantId }),
    ),
  )
}

export function auditOrderSubscription(kyu: Kyu, pool: Pool): Subscription {
  return kyu.subscribe(orderPlaced, {
    name: 'audit-order',
    handler: (ctx) => auditOrder(pool, kyu, ctx),
  })
}
