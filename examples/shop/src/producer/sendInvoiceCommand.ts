import type { Kyu } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { withTransaction } from '../db/pool.js'
import { sendInvoice } from '../messages.js'

export interface SendInvoiceCommandInput {
  tenantId: string
  orderId: string
  invoiceId: string
}

export interface SentInvoiceCommand {
  invoiceId: string
  envelopeId: string
}

/** The order id named on the request has no row for this tenant. */
export class OrderNotFoundError extends Error {
  constructor(orderId: string) {
    super(`order ${orderId} not found`)
    this.name = 'OrderNotFoundError'
  }
}

/** One transaction: checks the order exists, then one publish of shop.invoice.send. Writes no shop_invoice row — that is the point. */
export function sendInvoiceCommand(pool: Pool, kyu: Kyu, input: SendInvoiceCommandInput): Promise<SentInvoiceCommand> {
  return withTransaction(pool, async (client) => {
    // Checked in the same transaction as the publish: a stale or mistyped
    // order id must never be indistinguishable from the intended fault.
    const order = await client.query('SELECT 1 FROM shop_order WHERE id = $1 AND tenant_id = $2', [
      input.orderId,
      input.tenantId,
    ])
    if (order.rowCount === 0) throw new OrderNotFoundError(input.orderId)

    const envelope = await kyu.publish(
      client,
      sendInvoice,
      { orderId: input.orderId, invoiceId: input.invoiceId },
      { tenantId: input.tenantId },
    )
    return { invoiceId: input.invoiceId, envelopeId: envelope.id }
  })
}
