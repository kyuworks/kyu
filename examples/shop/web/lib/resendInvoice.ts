/** Where OrdersPage posts the simulated-fault resend. Named so a test can pin it. */
export const RESEND_INVOICE_PATH = '/invoices'

// No invoiceId field: an absent one makes the server send the command for an
// id with no shop_invoice row, the simulated fault (see src/ui/requests.ts).
/** The request body `POST /invoices` expects for the simulated fault: the order id only. */
export function buildResendInvoiceBody(orderId: string): string {
  return JSON.stringify({ orderId })
}
