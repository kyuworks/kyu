import type { DurableHandlerContext, Kinesin, MessageData, Subscription } from '@kinesin/sdk'
import { NonRetryableError } from '@kinesin/sdk'
import type { Pool, PoolClient } from 'pg'
import type { PlaygroundConfig } from '../config.js'
import { withTransaction } from '../db/pool.js'
import { orderPlaced, orderShipped } from '../messages.js'

type OrderPlacedContext = DurableHandlerContext<MessageData<typeof orderPlaced>>

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
  kinesin: Kinesin,
  config: PlaygroundConfig,
  ctx: OrderPlacedContext,
): Promise<void> {
  const { tenantId } = ctx.envelope
  if (tenantId === null) throw new NonRetryableError(`watch-shipping: envelope ${ctx.envelope.id} has no tenantId`)
  const { orderId } = ctx.envelope.data

  await withTransaction(pool, (tx) =>
    kinesin.onceById(tx, ctx.envelope.id, 'watch-shipping:waiting', () =>
      logRow(tx, 'watch-shipping:waiting', ctx.envelope.id, orderId, tenantId),
    ),
  )

  await ctx.sleepFor('5s')

  const result = await ctx.waitFor(orderShipped, {
    where: { field: 'data.orderId', equals: orderId },
    timeout: config.watchShippingTimeout,
  })

  await withTransaction(pool, (tx) =>
    kinesin.onceById(tx, ctx.envelope.id, 'watch-shipping:done', async () => {
      if (result.kind === 'message') {
        await tx.query('UPDATE shop_order SET shipped_at = now() WHERE id = $1', [orderId])
        await logRow(tx, 'watch-shipping:completed', ctx.envelope.id, orderId, tenantId, result.envelope.data.carrier)
      } else {
        await logRow(tx, 'watch-shipping:timeout', ctx.envelope.id, orderId, tenantId)
      }
    }),
  )
}

export function watchShippingSubscription(kinesin: Kinesin, pool: Pool, config: PlaygroundConfig): Subscription {
  return kinesin.durable(orderPlaced, {
    name: 'watch-shipping',
    executionTimeout: '1h',
    // A worker stopped while the body executes (not while parked in a wait)
    // fails that attempt; retrying is safe because every write goes through onceById.
    retries: 3,
    handler: (ctx) => watchShipping(pool, kinesin, config, ctx),
  })
}
