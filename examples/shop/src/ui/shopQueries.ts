import { z } from 'zod'
import { WATCH_SHIPPING_TIMEOUT } from '../handlers/watchShipping.js'
import type { OrderStage } from '../shop.js'
import type { CountsSource } from './busCounts.js'

export interface ShopProduct {
  id: string
  sku: string
  name: string
  priceCents: number
}

export interface ShopOrderLine {
  productId: string
  name: string
  quantity: number
  unitPriceCents: number
}

export interface ShopOrder {
  id: string
  customerId: string
  totalCents: number
  paidAt: string | null
  stage: OrderStage
  lines: ShopOrderLine[]
}

// How many of the tenant's newest orders /orders.json reads, mirrors
// busCounts.ts's own ENGINE_WINDOW_LIMIT constant.
export const ORDER_HISTORY_LIMIT = 50

const productRowSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  price_cents: z.coerce.number().int(),
})

/** Every product in the catalogue, ordered by sku. */
export async function readProducts(db: CountsSource): Promise<ShopProduct[]> {
  const result = await db.query('SELECT id::text, sku, name, price_cents FROM shop_product ORDER BY sku', [])
  return result.rows.map((row) => {
    const parsed = productRowSchema.parse(row)
    return { id: parsed.id, sku: parsed.sku, name: parsed.name, priceCents: parsed.price_cents }
  })
}

// pg returns timestamptz as a Date; ShopOrder's own contract is a string.
const timestampSchema = z
  .union([z.string(), z.date()])
  .nullable()
  .transform((value) => (value instanceof Date ? value.toISOString() : value))

const orderHeaderRowSchema = z.object({
  id: z.string(),
  customer_id: z.string(),
  total_cents: z.coerce.number().int(),
  paid_at: timestampSchema,
  shipped_at: timestampSchema,
  invoice_sent_at: timestampSchema,
  timed_out: z.boolean(),
})
type OrderHeaderRow = z.infer<typeof orderHeaderRowSchema>

const orderLineRowSchema = z.object({
  order_id: z.string(),
  product_id: z.string(),
  name: z.string(),
  quantity: z.coerce.number().int(),
  unit_price_cents: z.coerce.number().int(),
})
type OrderLineRow = z.infer<typeof orderLineRowSchema>

// Postgres array literal for `= ANY($n::uuid[])`; readonly string[] is not a
// QueryParam. Mirrors busCounts.ts's own private textArrayLiteral.
function uuidArrayLiteral(ids: readonly string[]): string {
  return `{${ids.join(',')}}`
}

async function readOrderHeaders(db: CountsSource, tenantId: string): Promise<OrderHeaderRow[]> {
  const result = await db.query(
    `SELECT o.id::text, o.customer_id::text, o.total_cents, o.paid_at, o.shipped_at,
            i.sent_at AS invoice_sent_at,
            EXISTS (SELECT 1 FROM shop_handler_log h WHERE h.order_id = o.id AND h.handler = $2) AS timed_out
     FROM shop_order o
     LEFT JOIN shop_invoice i ON i.order_id = o.id
     WHERE o.tenant_id = $1
     ORDER BY o.id DESC
     LIMIT $3`,
    [tenantId, WATCH_SHIPPING_TIMEOUT, ORDER_HISTORY_LIMIT],
  )
  return result.rows.map((row) => orderHeaderRowSchema.parse(row))
}

async function readOrderLines(db: CountsSource, orderIds: readonly string[]): Promise<OrderLineRow[]> {
  if (orderIds.length === 0) return []
  const result = await db.query(
    `SELECT ol.order_id::text, ol.product_id::text, p.name, ol.quantity, ol.unit_price_cents
     FROM shop_order_line ol
     JOIN shop_product p ON p.id = ol.product_id
     WHERE ol.order_id::text = ANY($1::text[])`,
    [uuidArrayLiteral(orderIds)],
  )
  return result.rows.map((row) => orderLineRowSchema.parse(row))
}

/** Stage precedence, highest first: shipped, then timed out, then invoice sent, then placed. */
export function orderStage(row: {
  shippedAt: string | null
  timedOut: boolean
  invoiceSentAt: string | null
}): OrderStage {
  if (row.shippedAt !== null) return 'shipped'
  if (row.timedOut) return 'timed-out'
  if (row.invoiceSentAt !== null) return 'invoice-sent'
  return 'placed'
}

/** The newest ORDER_HISTORY_LIMIT orders for the tenant, newest first, each with its lines and stage. */
export async function readOrders(db: CountsSource, tenantId: string): Promise<ShopOrder[]> {
  const headers = await readOrderHeaders(db, tenantId)
  const lineRows = await readOrderLines(
    db,
    headers.map((header) => header.id),
  )

  const linesByOrder = new Map<string, ShopOrderLine[]>()
  for (const line of lineRows) {
    const lines = linesByOrder.get(line.order_id) ?? []
    lines.push({
      productId: line.product_id,
      name: line.name,
      quantity: line.quantity,
      unitPriceCents: line.unit_price_cents,
    })
    linesByOrder.set(line.order_id, lines)
  }

  return headers.map((header) => ({
    id: header.id,
    customerId: header.customer_id,
    totalCents: header.total_cents,
    paidAt: header.paid_at,
    stage: orderStage({
      shippedAt: header.shipped_at,
      timedOut: header.timed_out,
      invoiceSentAt: header.invoice_sent_at,
    }),
    lines: linesByOrder.get(header.id) ?? [],
  }))
}
