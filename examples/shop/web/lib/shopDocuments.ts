import { z } from 'zod'

export interface ShopProduct {
  id: string
  sku: string
  name: string
  priceCents: number
}

export type ProductsDocumentOutcome = { ok: true; products: ShopProduct[] } | { ok: false; error: string }

const shopProductSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  priceCents: z.number(),
})
const productsDocumentSchema = z.object({ products: z.array(shopProductSchema) })

// Mirrors src/ui/handleRequest.ts's parseBody: the first Zod issue's path and message.
function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues.at(0)
  if (issue === undefined) return 'invalid response body'
  const path = issue.path.join('.')
  return path === '' ? issue.message : `${path}: ${issue.message}`
}

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

export interface PlacedOrder {
  orderId: string
  invoiceId: string
  totalCents: number
  orderPlacedEnvelopeId: string
  sendInvoiceEnvelopeId: string
}

const placedOrderSchema = z.object({
  orderId: z.string(),
  invoiceId: z.string(),
  totalCents: z.number(),
  orderPlacedEnvelopeId: z.string(),
  sendInvoiceEnvelopeId: z.string(),
})

/** Parses a `POST /orders` response body, or undefined when it is not the agreed shape. */
export function parsePlacedOrder(body: string): PlacedOrder | undefined {
  try {
    return placedOrderSchema.parse(JSON.parse(body))
  } catch {
    return undefined
  }
}
