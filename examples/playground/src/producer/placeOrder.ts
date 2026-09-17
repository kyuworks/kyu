import type { Kinesin } from '@kinesin/sdk'
import { uuidv7 } from '@kinesin/sdk'
import type { Pool, PoolClient } from 'pg'
import { withTransaction } from '../db/pool.js'
import { orderPlaced, sendInvoice } from '../messages.js'

export interface PlaceOrderInput {
  tenantId: string
  customerId: string
}

export interface PlacedOrderEnvelopeIds {
  orderPlaced: string
  sendInvoice: string
}

export interface PlacedOrder {
  orderId: string
  invoiceId: string
  envelopeIds: PlacedOrderEnvelopeIds
}

// Interior: runs on a caller-supplied client without opening or closing a
// transaction, so an integration test can drive it inside its own BEGIN/ROLLBACK.
export async function placeOrderOn(client: PoolClient, kinesin: Kinesin, input: PlaceOrderInput): Promise<PlacedOrder> {
  const orderId = uuidv7()
  const invoiceId = uuidv7()

  await client.query('INSERT INTO shop_order (id, tenant_id, customer_id) VALUES ($1, $2, $3)', [
    orderId,
    input.tenantId,
    input.customerId,
  ])
  await client.query('INSERT INTO shop_invoice (id, order_id, tenant_id) VALUES ($1, $2, $3)', [
    invoiceId,
    orderId,
    input.tenantId,
  ])

  const orderPlacedEnvelope = await kinesin.publish(
    client,
    orderPlaced,
    { orderId, customerId: input.customerId },
    { tenantId: input.tenantId },
  )
  const sendInvoiceEnvelope = await kinesin.publish(
    client,
    sendInvoice,
    { orderId, invoiceId },
    { tenantId: input.tenantId },
  )

  return {
    orderId,
    invoiceId,
    envelopeIds: { orderPlaced: orderPlacedEnvelope.id, sendInvoice: sendInvoiceEnvelope.id },
  }
}

/** One transaction: two INSERTs then two publishes, committed together. */
export function placeOrder(pool: Pool, kinesin: Kinesin, input: PlaceOrderInput): Promise<PlacedOrder> {
  return withTransaction(pool, (client) => placeOrderOn(client, kinesin, input))
}
