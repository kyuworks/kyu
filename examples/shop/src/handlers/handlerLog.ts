import type { Queryable } from '@kyuworks/sdk'

export interface HandlerLogEntry {
  handler: string
  envelopeId: string
  orderId: string
  tenantId: string
  /** What this handler recorded — a carrier, an invoice id, the notification text. Omitted writes NULL. */
  note?: string | null
}

// The one writer of shop_handler_log. shop_handler_log_once_idx
// (migrations/0001_shop.sql) still turns a second row for the same handler and
// envelope into an error; onceById is what keeps it from firing.
export async function writeHandlerLogRow(tx: Queryable, entry: HandlerLogEntry): Promise<void> {
  await tx.query(
    'INSERT INTO shop_handler_log (handler, envelope_id, order_id, tenant_id, pid, note) VALUES ($1, $2, $3, $4, $5, $6)',
    [entry.handler, entry.envelopeId, entry.orderId, entry.tenantId, process.pid, entry.note ?? null],
  )
}
