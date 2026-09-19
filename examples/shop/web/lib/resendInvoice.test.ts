import { describe, expect, it } from 'vitest'
import { RESEND_INVOICE_PATH, buildResendInvoiceBody, nextResendInvoiceState } from './resendInvoice'

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

describe('nextResendInvoiceState', () => {
  it('is ok: false, with the server error, on a non-2xx response', () => {
    const state = nextResendInvoiceState({
      ok: false,
      status: 404,
      bodyText: JSON.stringify({ error: 'order order-1 not found' }),
    })

    expect(state).toEqual({ ok: false, error: 'resend invoice failed: order order-1 not found' })
  })

  it('is ok: true on a good 201 response', () => {
    const state = nextResendInvoiceState({
      ok: true,
      status: 201,
      bodyText: JSON.stringify({ orderId: 'order-1', invoiceId: 'invoice-1', envelopeId: 'envelope-1' }),
    })

    expect(state).toEqual({ ok: true })
  })
})
