import { defineCommand, defineEvent } from '@kinesin/sdk'
import { z } from 'zod'

export const orderPlaced = defineEvent({
  name: 'shop.order.placed',
  version: 1,
  data: z.object({ orderId: z.uuid(), customerId: z.uuid() }),
})

export const orderShipped = defineEvent({
  name: 'shop.order.shipped',
  version: 1,
  data: z.object({ orderId: z.uuid(), carrier: z.string().min(1) }),
})

export const sendInvoice = defineCommand({
  name: 'shop.invoice.send',
  version: 1,
  data: z.object({ orderId: z.uuid(), invoiceId: z.uuid() }),
})
