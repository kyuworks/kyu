import type { Qtaxis } from '@qtaxis/sdk'
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

/** One transaction: one publish of shop.invoice.send. Writes no shop_invoice row — that is the point. */
export function sendInvoiceCommand(
  pool: Pool,
  qtaxis: Qtaxis,
  input: SendInvoiceCommandInput,
): Promise<SentInvoiceCommand> {
  return withTransaction(pool, async (client) => {
    const envelope = await qtaxis.publish(
      client,
      sendInvoice,
      { orderId: input.orderId, invoiceId: input.invoiceId },
      { tenantId: input.tenantId },
    )
    return { invoiceId: input.invoiceId, envelopeId: envelope.id }
  })
}
