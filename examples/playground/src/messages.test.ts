import { createEnvelope, uuidv7 } from '@kinesin/sdk'
import { describe, expect, it } from 'vitest'
import { orderPlaced, orderShipped, sendInvoice } from './messages.js'

describe('messages', () => {
  it('defines the two events and the command, all at version 1', () => {
    expect(orderPlaced.kind).toBe('event')
    expect(orderPlaced.name).toBe('shop.order.placed')
    expect(orderPlaced.version).toBe(1)
    expect(orderShipped.kind).toBe('event')
    expect(orderShipped.name).toBe('shop.order.shipped')
    expect(orderShipped.version).toBe(1)
    expect(sendInvoice.kind).toBe('command')
    expect(sendInvoice.name).toBe('shop.invoice.send')
    expect(sendInvoice.version).toBe(1)
  })

  it('rejects data that fails its schema for orderPlaced', async () => {
    await expect(
      createEnvelope(
        orderPlaced,
        { orderId: 'not-a-uuid', customerId: uuidv7() },
        { tenantId: uuidv7(), source: 'test' },
      ),
    ).rejects.toThrow()
  })

  it('rejects data that fails its schema for orderShipped', async () => {
    await expect(
      createEnvelope(orderShipped, { orderId: 'not-a-uuid', carrier: 'ups' }, { tenantId: uuidv7(), source: 'test' }),
    ).rejects.toThrow()
  })

  it('rejects data that fails its schema for sendInvoice', async () => {
    await expect(
      createEnvelope(
        sendInvoice,
        { orderId: 'not-a-uuid', invoiceId: uuidv7() },
        { tenantId: uuidv7(), source: 'test' },
      ),
    ).rejects.toThrow()
  })
})
