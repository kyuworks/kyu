import type { HandlerContext, Kyu, MessageData, Subscription } from '@kyuworks/sdk'
import { NonRetryableError } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { withTransaction } from '../db/pool.js'
import { sendInvoice } from '../messages.js'
import { requireTenant } from './tenant.js'

type SendInvoiceContext = HandlerContext<MessageData<typeof sendInvoice>>

// Exported so the unit test can drive it directly against a fake pool,
// without reaching into the opaque Hatchet workflow subscribe() builds.
export async function handleSendInvoice(pool: Pool, kyu: Kyu, ctx: SendInvoiceContext): Promise<void> {
  const tenantId = requireTenant('send-invoice', ctx)
  const { orderId, invoiceId } = ctx.envelope.data

  await withTransaction(pool, (tx) =>
    kyu.onceById(tx, ctx.envelope.id, 'send-invoice', async () => {
      const updated = await tx.query(
        'UPDATE shop_invoice SET sent_at = now() WHERE id = $1 AND order_id = $2 RETURNING id',
        [invoiceId, orderId],
      )
      // A domain condition, not a transport fault (design § 9.3): no retry
      // will make a missing invoice row appear.
      if (updated.rows.length === 0) {
        throw new NonRetryableError(`send-invoice: no shop_invoice row for invoice ${invoiceId} on order ${orderId}`)
      }
      await tx.query(
        'INSERT INTO shop_handler_log (handler, envelope_id, order_id, tenant_id, pid, note) VALUES ($1, $2, $3, $4, $5, $6)',
        ['send-invoice', ctx.envelope.id, orderId, tenantId, process.pid, invoiceId],
      )
    }),
  )
}

export function sendInvoiceSubscription(kyu: Kyu, pool: Pool): Subscription {
  return kyu.subscribe(sendInvoice, {
    name: 'send-invoice',
    concurrency: { key: 'input.data.orderId', maxRuns: 1, strategy: 'fifo' },
    retries: 0,
    handler: (ctx) => handleSendInvoice(pool, kyu, ctx),
  })
}
