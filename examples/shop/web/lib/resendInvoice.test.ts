import { describe, expect, it } from 'vitest'
import { RESEND_INVOICE_PATH, buildResendInvoiceBody } from './resendInvoice'

describe('RESEND_INVOICE_PATH', () => {
  it('is the route the server sends the invoice command on', () => {
    expect(RESEND_INVOICE_PATH).toBe('/invoices')
  })
})

describe('buildResendInvoiceBody', () => {
  it('carries the order id only, so the server sends the fault for a fresh invoice id', () => {
    const body = buildResendInvoiceBody('order-1')

    expect(JSON.parse(body)).toEqual({ orderId: 'order-1' })
  })
})
