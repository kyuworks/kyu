import { z } from 'zod'
import { firstIssueMessage } from './fetchJson'

const shopProductSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  priceCents: z.number(),
})
export type ShopProduct = z.infer<typeof shopProductSchema>

const productsDocumentSchema = z.object({ products: z.array(shopProductSchema) })
export type ProductsDocumentOutcome = { ok: true; products: ShopProduct[] } | { ok: false; error: string }

/** Parses a `GET /products.json` body. The only place that body is looked at. */
export function parseProductsDocument(body: string): ProductsDocumentOutcome {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { ok: false, error: 'invalid JSON body' }
  }
  const result = productsDocumentSchema.safeParse(json)
  if (!result.success) return { ok: false, error: firstIssueMessage(result.error) }
  return { ok: true, products: result.data.products }
}

const orderStageSchema = z.enum(['placed', 'invoice-sent', 'shipped', 'timed-out'])
export type OrderStage = z.infer<typeof orderStageSchema>

const shopOrderLineSchema = z.object({
  productId: z.string(),
  name: z.string(),
  quantity: z.number(),
  unitPriceCents: z.number(),
})
export type ShopOrderLine = z.infer<typeof shopOrderLineSchema>

const shopOrderSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  totalCents: z.number(),
  paidAt: z.string().nullable(),
  stage: orderStageSchema,
  lines: z.array(shopOrderLineSchema),
})
export type ShopOrder = z.infer<typeof shopOrderSchema>

const ordersDocumentSchema = z.object({ orders: z.array(shopOrderSchema) })
export type OrdersDocumentOutcome = { ok: true; orders: ShopOrder[] } | { ok: false; error: string }

/** Parses a `GET /orders.json` body. The only place that body is looked at. */
export function parseOrdersDocument(body: string): OrdersDocumentOutcome {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { ok: false, error: 'invalid JSON body' }
  }
  const result = ordersDocumentSchema.safeParse(json)
  if (!result.success) return { ok: false, error: firstIssueMessage(result.error) }
  return { ok: true, orders: result.data.orders }
}

const placedOrderSchema = z.object({
  orderId: z.string(),
  invoiceId: z.string(),
  totalCents: z.number(),
  orderPlacedEnvelopeId: z.string(),
  sendInvoiceEnvelopeId: z.string(),
})
export type PlacedOrder = z.infer<typeof placedOrderSchema>
export type PlacedOrderOutcome = { ok: true; order: PlacedOrder } | { ok: false; error: string }

/** Parses a `POST /orders` response body. */
export function parsePlacedOrder(body: string): PlacedOrderOutcome {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { ok: false, error: 'invalid JSON body' }
  }
  const result = placedOrderSchema.safeParse(json)
  if (!result.success) return { ok: false, error: firstIssueMessage(result.error) }
  return { ok: true, order: result.data }
}
