import type { Kyu } from '@kyuworks/sdk'
import { uuidv7 } from '@kyuworks/sdk'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { withTransaction } from '../db/pool.js'
import { orderPlaced, sendInvoice } from '../messages.js'

export interface PlaceOrderLine {
  productId: string
  quantity: number
}

export interface PlaceOrderInput {
  tenantId: string
  customerId: string
  // Omitted by the CLI and by every integration suite on main: an order with
  // no lines and a zero total, exactly what those tests already assert about.
  lines?: readonly PlaceOrderLine[]
}

export interface PlacedOrderEnvelopeIds {
  orderPlaced: string
  sendInvoice: string
}

export interface PlacedOrder {
  orderId: string
  invoiceId: string
  totalCents: number
  envelopeIds: PlacedOrderEnvelopeIds
}

const totalRowSchema = z.object({ total_cents: z.coerce.number().int() })

// An unknown product id throws before anything is published: the JOIN below
// would otherwise silently drop that line and place an order half-built.
async function insertLines(client: PoolClient, orderId: string, lines: readonly PlaceOrderLine[]): Promise<number> {
  const result = await client.query(
    `INSERT INTO shop_order_line (id, order_id, product_id, quantity, unit_price_cents)
     SELECT gen_random_uuid(), $1, p.id, line.quantity, p.price_cents
     FROM jsonb_to_recordset($2::jsonb) AS line(product_id uuid, quantity int)
     JOIN shop_product p ON p.id = line.product_id`,
    [orderId, JSON.stringify(lines.map((line) => ({ product_id: line.productId, quantity: line.quantity })))],
  )
  if (result.rowCount !== lines.length) {
    throw new Error(`placeOrder: a line named a product id that does not exist for order ${orderId}`)
  }

  const totalResult = await client.query(
    `UPDATE shop_order
     SET total_cents = coalesce((SELECT sum(quantity * unit_price_cents) FROM shop_order_line WHERE order_id = $1), 0)
     WHERE id = $1
     RETURNING total_cents`,
    [orderId],
  )
  return totalRowSchema.parse(totalResult.rows[0]).total_cents
}

// Interior: runs on a caller-supplied client without opening or closing a
// transaction, so an integration test can drive it inside its own BEGIN/ROLLBACK.
export async function placeOrderOn(client: PoolClient, kyu: Kyu, input: PlaceOrderInput): Promise<PlacedOrder> {
  const orderId = uuidv7()
  const invoiceId = uuidv7()

  await client.query('INSERT INTO shop_order (id, tenant_id, customer_id, paid_at) VALUES ($1, $2, $3, now())', [
    orderId,
    input.tenantId,
    input.customerId,
  ])
  await client.query('INSERT INTO shop_invoice (id, order_id, tenant_id) VALUES ($1, $2, $3)', [
    invoiceId,
    orderId,
    input.tenantId,
  ])

  const lines = input.lines ?? []
  const totalCents = lines.length > 0 ? await insertLines(client, orderId, lines) : 0

  const orderPlacedEnvelope = await kyu.publish(
    client,
    orderPlaced,
    { orderId, customerId: input.customerId },
    { tenantId: input.tenantId },
  )
  const sendInvoiceEnvelope = await kyu.publish(
    client,
    sendInvoice,
    { orderId, invoiceId },
    { tenantId: input.tenantId },
  )

  return {
    orderId,
    invoiceId,
    totalCents,
    envelopeIds: { orderPlaced: orderPlacedEnvelope.id, sendInvoice: sendInvoiceEnvelope.id },
  }
}

/** One transaction: two INSERTs then two publishes, committed together. */
export function placeOrder(pool: Pool, kyu: Kyu, input: PlaceOrderInput): Promise<PlacedOrder> {
  return withTransaction(pool, (client) => placeOrderOn(client, kyu, input))
}
