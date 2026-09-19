import { describeFetchFailure } from './fetchJson'
import type { JsonFetchOutcome } from './fetchJson'

/** Where OrdersPage posts the simulated-fault resend. Named so a test can pin it. */
export const RESEND_INVOICE_PATH = '/invoices'

// No invoiceId field: an absent one makes the server send the command for an
// id with no shop_invoice row, the simulated fault (see src/ui/requests.ts).
/** The request body `POST /invoices` expects for the simulated fault: the order id only. */
export function buildResendInvoiceBody(orderId: string): string {
  return JSON.stringify({ orderId })
}

export type ResendInvoiceState = { ok: true } | { ok: false; error: string }

// Pure and unit-tested: reverting the route or the non-2xx branch fails a test, not just a click.
export function nextResendInvoiceState(outcome: JsonFetchOutcome): ResendInvoiceState {
  if (!outcome.ok) {
    return { ok: false, error: `resend invoice failed: ${describeFetchFailure(outcome.status, outcome.bodyText)}` }
  }
  return { ok: true }
}
