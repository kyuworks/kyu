import type { DurableHandlerContext, Qtaxis, MessageData, Subscription } from '@qtaxis/sdk'
import type { Pool, PoolClient } from 'pg'
import type { PlaygroundConfig } from '../config.js'
import { withTransaction } from '../db/pool.js'
import { orderPlaced, orderShipped } from '../messages.js'
import { requireTenant } from './tenant.js'

type OrderPlacedContext = DurableHandlerContext<MessageData<typeof orderPlaced>>

// ui/busTopology.ts imports these so its handler list can't drift from what this file writes.
export const WATCH_SHIPPING_WAITING = 'watch-shipping:waiting'
export const WATCH_SHIPPING_COMPLETED = 'watch-shipping:completed'
export const WATCH_SHIPPING_TIMEOUT = 'watch-shipping:timeout'

async function logRow(
  tx: PoolClient,
  handler: string,
  envelopeId: string,
  orderId: string,
  tenantId: string,
  note: string | null = null,
): Promise<void> {
  await tx.query(
    'INSERT INTO shop_handler_log (handler, envelope_id, order_id, tenant_id, pid, note) VALUES ($1, $2, $3, $4, $5, $6)',
    [handler, envelopeId, orderId, tenantId, process.pid, note],
  )
}

// The body re-runs from the top on every reassignment (durable.ts), so both
// writes go through onceById under their own handler names: the waiting row
// before the wait, the completed/timeout row after it.
async function watchShipping(
  pool: Pool,
  qtaxis: Qtaxis,
  config: PlaygroundConfig,
  ctx: OrderPlacedContext,
): Promise<void> {
  const tenantId = requireTenant('watch-shipping', ctx)
  const { orderId } = ctx.envelope.data

  await withTransaction(pool, (tx) =>
    qtaxis.onceById(tx, ctx.envelope.id, WATCH_SHIPPING_WAITING, () =>
      logRow(tx, WATCH_SHIPPING_WAITING, ctx.envelope.id, orderId, tenantId),
    ),
  )

  await ctx.sleepFor('5s')

  const result = await ctx.waitFor(orderShipped, {
    where: { field: 'data.orderId', equals: orderId },
    timeout: config.watchShippingTimeout,
  })

  await withTransaction(pool, (tx) =>
    qtaxis.onceById(tx, ctx.envelope.id, 'watch-shipping:done', async () => {
      if (result.kind === 'message') {
        await tx.query('UPDATE shop_order SET shipped_at = now() WHERE id = $1', [orderId])
        await logRow(tx, WATCH_SHIPPING_COMPLETED, ctx.envelope.id, orderId, tenantId, result.envelope.data.carrier)
      } else {
        await logRow(tx, WATCH_SHIPPING_TIMEOUT, ctx.envelope.id, orderId, tenantId)
      }
    }),
  )
}

export function watchShippingSubscription(qtaxis: Qtaxis, pool: Pool, config: PlaygroundConfig): Subscription {
  return qtaxis.durable(orderPlaced, {
    name: 'watch-shipping',
    executionTimeout: '1h',
    // A worker stopped while the body executes (not while parked in a wait)
    // fails that attempt; retrying is safe because every write goes through onceById.
    retries: 3,
    handler: (ctx) => watchShipping(pool, qtaxis, config, ctx),
  })
}
