import type { HandlerContext, Kyu, MessageData, Subscription } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { withTransaction } from '../db/pool.js'
import { notifyStaff } from '../messages.js'
import { readNotifyText } from '../workflow/store.js'
import { requireTenant } from './tenant.js'

export const NOTIFY_STAFF_NAME = 'notify-staff'

type NotifyStaffContext = HandlerContext<MessageData<typeof notifyStaff>>

// The "notification" in this example is a shop_handler_log row, the same way
// every other handler here (sendInvoice.ts, recordShipment.ts) records what
// it did; #95 tracks pulling that INSERT into one shared helper, so this one
// is mirrored rather than reaching into watchShipping.ts's private logRow.
// The text is read from the pinned version by step id; it never travelled on
// the envelope (ADR decision 8).
export async function handleNotifyStaff(pool: Pool, kyu: Kyu, ctx: NotifyStaffContext): Promise<void> {
  const tenantId = requireTenant(NOTIFY_STAFF_NAME, ctx)
  const { versionId, stepId, orderId } = ctx.envelope.data

  await withTransaction(pool, (tx) =>
    kyu.onceById(tx, ctx.envelope.id, NOTIFY_STAFF_NAME, async () => {
      const text = await readNotifyText(tx, { tenantId, versionId, stepId })
      await tx.query(
        'INSERT INTO shop_handler_log (handler, envelope_id, order_id, tenant_id, pid, note) VALUES ($1, $2, $3, $4, $5, $6)',
        [NOTIFY_STAFF_NAME, ctx.envelope.id, orderId, tenantId, process.pid, text],
      )
    }),
  )
}

export function notifyStaffSubscription(kyu: Kyu, pool: Pool): Subscription {
  return kyu.subscribe(notifyStaff, {
    name: NOTIFY_STAFF_NAME,
    concurrency: { key: 'input.data.orderId', maxRuns: 1, strategy: 'fifo' },
    retries: 0,
    handler: (ctx) => handleNotifyStaff(pool, kyu, ctx),
  })
}
