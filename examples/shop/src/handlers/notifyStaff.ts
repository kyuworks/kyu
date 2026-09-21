import type { HandlerContext, Kyu, MessageData, Subscription } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { withTransaction } from '../db/pool.js'
import { notifyStaff } from '../messages.js'
import { readNotifyText } from '../workflow/store.js'
import { writeHandlerLogRow } from './handlerLog.js'
import { requireTenant } from './tenant.js'

export const NOTIFY_STAFF_NAME = 'notify-staff'

type NotifyStaffContext = HandlerContext<MessageData<typeof notifyStaff>>

// The "notification" in this example is a shop_handler_log row, written
// through handlerLog.ts like every other handler here. The text is read from
// the pinned version by step id; it never travelled on the envelope (ADR
// decision 8).
export async function handleNotifyStaff(pool: Pool, kyu: Kyu, ctx: NotifyStaffContext): Promise<void> {
  const tenantId = requireTenant(NOTIFY_STAFF_NAME, ctx)
  const envelopeId = ctx.envelope.id
  const { versionId, stepId, orderId } = ctx.envelope.data

  await withTransaction(pool, (tx) =>
    kyu.onceById(tx, envelopeId, NOTIFY_STAFF_NAME, async () => {
      const text = await readNotifyText(tx, { tenantId, versionId, stepId })
      await writeHandlerLogRow(tx, { handler: NOTIFY_STAFF_NAME, envelopeId, orderId, tenantId, note: text })
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
