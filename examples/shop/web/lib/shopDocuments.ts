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
