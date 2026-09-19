import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Kyu } from '@kyuworks/sdk'
import { Client } from 'pg'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ShopConfig } from '../config.js'
import { readConfig } from '../config.js'
import { createPool } from '../db/pool.js'
import { createShopKyu } from '../kyu.js'
import { placeOrder } from '../producer/placeOrder.js'
import { shipOrder } from '../producer/shipOrder.js'
import { spawnProcess, stopAllSpawnedProcesses } from './processes.js'
import type { SpawnedProcess } from './processes.js'

// Walks the flow the issue asks for: place an order with lines, watch the
// invoice get sent and the order get shipped, all against a real database
// and a real relay/worker pair. A second test proves S2 (an unknown product
// id rolls back the whole order and publishes nothing).
const RELAY_SCRIPT = path.resolve(import.meta.dirname, '../../dist/relay.js')
const WORKER_SCRIPT = path.resolve(import.meta.dirname, '../../dist/worker.js')
const namespace = `sf${randomBytes(3).toString('hex')}_`

// Seeded by migrations/0002_shop.sql; fixed so every database this migration
// is applied to agrees on the same product ids.
const MUG_ID = '0199a1c0-0001-7000-8000-000000000001'
const TOTE_ID = '0199a1c0-0001-7000-8000-000000000002'

let config: ShopConfig
let pool: Pool
let kyu: Kyu
let admin: Client
let relay: SpawnedProcess
let worker: SpawnedProcess

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, KYU_SHOP_DATABASE_URL: config.databaseUrl, KYU_SHOP_NAMESPACE: namespace }
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  describeState: () => string,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(`waitUntil timed out after ${timeoutMs}ms: ${describeState()}`)
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}

beforeAll(async () => {
  const base = readConfig()
  config = { ...base, namespace }
  pool = createPool(config.databaseUrl)
  kyu = createShopKyu(config)
  admin = new Client({ connectionString: config.databaseUrl })
  await admin.connect()

  relay = spawnProcess(RELAY_SCRIPT, childEnv())
  worker = spawnProcess(WORKER_SCRIPT, childEnv())
  await Promise.all([relay.ready, worker.ready])
}, 60_000)

afterAll(async () => {
  await stopAllSpawnedProcesses()
  await admin.end()
  await pool.end()
}, 90_000)

describe('shopFlow: checkout, invoice and shipping against the local engine', () => {
  it('checks out two lines, commits the total and the invoice in one transaction, then ships (S1)', async () => {
    const tenantId = randomUUID()
    const customerId = randomUUID()

    const placed = await placeOrder(pool, kyu, {
      tenantId,
      customerId,
      lines: [
        { productId: MUG_ID, quantity: 2 },
        { productId: TOTE_ID, quantity: 1 },
      ],
    })

    // 2 mugs at 1400 + 1 tote at 1800 = 4600; already visible right after
    // commit, since placeOrder computes it inside the same transaction.
    expect(placed.totalCents).toBe(4600)

    const lineRows = await admin.query(
      'SELECT product_id::text, quantity, unit_price_cents FROM shop_order_line WHERE order_id = $1 ORDER BY unit_price_cents',
      [placed.orderId],
    )
    expect(lineRows.rows).toEqual([
      { product_id: MUG_ID, quantity: 2, unit_price_cents: 1400 },
      { product_id: TOTE_ID, quantity: 1, unit_price_cents: 1800 },
    ])

    const orderRow = await admin.query('SELECT total_cents, paid_at FROM shop_order WHERE id = $1', [placed.orderId])
    expect(orderRow.rows[0]?.total_cents).toBe(4600)
    expect(orderRow.rows[0]?.paid_at).not.toBeNull()

    let sentAt: unknown
    await waitUntil(
      async () => {
        const result = await admin.query('SELECT sent_at FROM shop_invoice WHERE id = $1', [placed.invoiceId])
        sentAt = result.rows[0]?.sent_at
        return sentAt != null
      },
      60_000,
      () => `shop_invoice ${placed.invoiceId} sent_at is ${String(sentAt)}`,
    )

    await shipOrder(pool, kyu, { tenantId, orderId: placed.orderId, carrier: 'ups' })

    await waitUntil(
      async () => {
        const result = await admin.query('SELECT shipped_at FROM shop_order WHERE id = $1', [placed.orderId])
        return result.rows[0]?.shipped_at != null
      },
      60_000,
      () => `shop_order ${placed.orderId} never recorded shipped_at`,
    )

    // record-shipment (a plain subscriber) and watch-shipping (a parked durable
    // run woken by the same event) are two independent writers now; shipped_at
    // can land before watch-shipping's own completed row, so this polls too
    // instead of assuming the same commit wrote both, as one onceById block did before.
    let completedRowCount = 0
    await waitUntil(
      async () => {
        const completedLog = await admin.query(
          "SELECT 1 FROM shop_handler_log WHERE handler = 'watch-shipping:completed' AND order_id = $1",
          [placed.orderId],
        )
        completedRowCount = completedLog.rows.length
        return completedRowCount >= 1
      },
      60_000,
      () =>
        `shop_handler_log has ${String(completedRowCount)} watch-shipping:completed rows for order ${placed.orderId}, want at least 1`,
    )

    // Re-read once the poll has settled, so a duplicate completed row (a bug,
    // since onceById's unique index should make this impossible) is caught
    // instead of being masked by a poll that stops at the first sighting.
    const completedLog = await admin.query(
      "SELECT 1 FROM shop_handler_log WHERE handler = 'watch-shipping:completed' AND order_id = $1",
      [placed.orderId],
    )
    expect(completedLog.rows).toHaveLength(1)
  }, 180_000)

  it('an unknown product id commits nothing and publishes nothing (S2)', async () => {
    const tenantId = randomUUID()
    const unknownProductId = randomUUID()

    await expect(
      placeOrder(pool, kyu, {
        tenantId,
        customerId: randomUUID(),
        lines: [{ productId: unknownProductId, quantity: 1 }],
      }),
    ).rejects.toThrow(/product/)

    // A fresh tenant id: any row at all here means the rolled-back
    // transaction leaked something.
    const orderRows = await admin.query('SELECT 1 FROM shop_order WHERE tenant_id = $1', [tenantId])
    expect(orderRows.rows).toHaveLength(0)
    const invoiceRows = await admin.query('SELECT 1 FROM shop_invoice WHERE tenant_id = $1', [tenantId])
    expect(invoiceRows.rows).toHaveLength(0)
    const outboxRows = await admin.query('SELECT 1 FROM kyu_outbox WHERE tenant_id = $1', [tenantId])
    expect(outboxRows.rows).toHaveLength(0)
  }, 30_000)
})
