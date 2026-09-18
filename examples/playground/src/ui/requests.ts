import { z } from 'zod'

// The HTTP body is the trust edge: parsed once here, then handed to the
// producers as plain values (see handleRequest.ts).
export const placeOrderRequestSchema = z.object({
  tenantId: z.uuid(),
  customerId: z.uuid().optional(),
})

export type PlaceOrderRequest = z.infer<typeof placeOrderRequestSchema>

export const shipOrderRequestSchema = z.object({
  tenantId: z.uuid(),
  orderId: z.uuid(),
  carrier: z.string().min(1).optional(),
})

export type ShipOrderRequest = z.infer<typeof shipOrderRequestSchema>
