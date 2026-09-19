import { z } from 'zod'

// The HTTP body is the trust edge: parsed once here, then handed to the
// producers as plain values (see handleRequest.ts). The tenant is a server
// constant (shop.ts's DEMO_TENANT_ID), never a client-supplied field.
export const placeOrderRequestSchema = z.object({
  customerId: z.uuid().optional(),
  lines: z
    .array(z.object({ productId: z.uuid(), quantity: z.int().min(1).max(99) }))
    .min(1)
    .max(20),
})

export type PlaceOrderRequest = z.infer<typeof placeOrderRequestSchema>

export const shipOrderRequestSchema = z.object({
  orderId: z.uuid(),
  carrier: z.string().min(1).optional(),
})

export type ShipOrderRequest = z.infer<typeof shipOrderRequestSchema>

export const sendInvoiceRequestSchema = z.object({
  orderId: z.uuid(),
  // Absent means "an invoice id with no row": the simulated fault the orders page sends.
  invoiceId: z.uuid().optional(),
})

export type SendInvoiceRequest = z.infer<typeof sendInvoiceRequestSchema>
