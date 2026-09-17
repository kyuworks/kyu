import { createEnvelope, uuidv7 } from '@kinesin/sdk'
import { describe, expect, it } from 'vitest'
import { orderPlaced, orderShipped, sendInvoice } from './messages.js'

describe('messages', () => {
  it('defines the two events and the command', () => {
    expect(orderPlaced.kind).toBe('event')
    expect(orderPlaced.name).toBe('shop.order.placed')
    expect(orderShipped.kind).toBe('event')
    expect(orderShipped.name).toBe('shop.order.shipped')
    expect(sendInvoice.kind).toBe('command')
    expect(sendInvoice.name).toBe('shop.invoice.send')
  })

  it('rejects data that fails its schema', async () => {
    await expect(
      createEnvelope(
        orderPlaced,
        { orderId: 'not-a-uuid', customerId: uuidv7() },
        { tenantId: uuidv7(), source: 'test' },
      ),
    ).rejects.toThrow()
  })
})
