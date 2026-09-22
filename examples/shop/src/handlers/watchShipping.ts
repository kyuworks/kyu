import type { DurableHandlerContext, Kyu, MessageData, Subscription } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import type { ShopConfig } from '../config.js'
import { withTransaction } from '../db/pool.js'
import { orderPlaced, orderShipped } from '../messages.js'
import { writeHandlerLogRow } from './handlerLog.js'
import { requireTenant } from './tenant.js'

type OrderPlacedContext = DurableHandlerContext<MessageData<typeof orderPlaced>>

// ui/busTopology.ts imports these so its handler list and subscription name can't drift from what this file writes.
export const WATCH_SHIPPING_NAME = 'watch-shipping'
export const WATCH_SHIPPING_WAITING = `${WATCH_SHIPPING_NAME}:waiting`
export const WATCH_SHIPPING_COMPLETED = `${WATCH_SHIPPING_NAME}:completed`
export const WATCH_SHIPPING_TIMEOUT = `${WATCH_SHIPPING_NAME}:timeout`

// The body re-runs from the top on every reassignment (durable.ts), so both
// writes go through onceById under their own handler names: the waiting row
// before the wait, the completed/timeout row after it.
async function watchShipping(pool: Pool, kyu: Kyu, config: ShopConfig, ctx: OrderPlacedContext): Promise<void> {
  const tenantId = requireTenant(WATCH_SHIPPING_NAME, ctx)
  const envelopeId = ctx.envelope.id
  const { orderId } = ctx.envelope.data

  await withTransaction(pool, (tx) =>
    kyu.onceById(tx, envelopeId, WATCH_SHIPPING_WAITING, () =>
      writeHandlerLogRow(tx, { handler: WATCH_SHIPPING_WAITING, envelopeId, orderId, tenantId }),
    ),
  )

  await ctx.sleepFor('5s')

  const result = await ctx.waitFor(orderShipped, {
    where: { field: 'data.orderId', equals: orderId },
    timeout: config.watchShippingTimeout,
  })

  await withTransaction(pool, (tx) =>
    kyu.onceById(tx, envelopeId, `${WATCH_SHIPPING_NAME}:done`, async () => {
      const handler = result.kind === 'message' ? WATCH_SHIPPING_COMPLETED : WATCH_SHIPPING_TIMEOUT
      const note = result.kind === 'message' ? result.envelope.data.carrier : null
      await writeHandlerLogRow(tx, { handler, envelopeId, orderId, tenantId, note })
    }),
  )
}

export function watchShippingSubscription(kyu: Kyu, pool: Pool, config: ShopConfig): Subscription {
  return kyu.durable(orderPlaced, {
    name: WATCH_SHIPPING_NAME,
    executionTimeout: '1h',
    scheduleTimeout: '30m',
    handler: (ctx) => watchShipping(pool, kyu, config, ctx),
  })
}
