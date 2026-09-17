import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { HatchetClient, Kinesin } from '@kinesin/sdk'
import { createHatchetClient, uuidv7 } from '@kinesin/sdk'
import { Client } from 'pg'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlaygroundConfig } from '../config.js'
import { readConfig } from '../config.js'
import { createPool, withTransaction } from '../db/pool.js'
import { createPlaygroundKinesin } from '../kinesin.js'
import { sendInvoice } from '../messages.js'
import { placeOrder } from '../producer/placeOrder.js'
import { spawnProcess, stopAllSpawnedProcesses } from './processes.js'
import type { SpawnedProcess } from './processes.js'

// Drives the relay and worker as real child processes against the local
// engine (subscribe/worker are proved in isolation by the SDK's own suite;
// this proves the transactional outbox, the relay and the worker chained
// together the way a consumer runs them). Namespaced per run so parallel
// worktrees sharing one engine never meet (producer.integration.test.ts's
// own convention).
const RELAY_SCRIPT = path.resolve(import.meta.dirname, '../../dist/relay.js')
const WORKER_SCRIPT = path.resolve(import.meta.dirname, '../../dist/worker.js')
const namespace = `lp${randomBytes(3).toString('hex')}_`

let config: PlaygroundConfig
let pool: Pool
let kinesin: Kinesin
let admin: Client
let engine: HatchetClient
let relay: SpawnedProcess
let worker: SpawnedProcess

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, KINESIN_EXAMPLE_DATABASE_URL: config.databaseUrl, KINESIN_EXAMPLE_NAMESPACE: namespace }
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

interface LogRow {
  handler: string
  envelope_id: string
  tenant_id: string
  note: string | null
}

async function handlerLogRows(envelopeIds: readonly string[]): Promise<LogRow[]> {
  const result = await admin.query<LogRow>(
    'SELECT handler, envelope_id, tenant_id, note FROM shop_handler_log WHERE envelope_id = ANY($1) ORDER BY seq',
    [envelopeIds],
  )
  return result.rows
}

beforeAll(async () => {
  const base = readConfig()
  config = { ...base, namespace }
  pool = createPool(config.databaseUrl)
  kinesin = createPlaygroundKinesin(config)
  admin = new Client({ connectionString: config.databaseUrl })
  await admin.connect()
  engine = createHatchetClient({ namespace })

  relay = spawnProcess(RELAY_SCRIPT, childEnv())
  worker = spawnProcess(WORKER_SCRIPT, childEnv())
  await Promise.all([relay.ready, worker.ready])
}, 60_000)

afterAll(async () => {
  await stopAllSpawnedProcesses()
  await admin.end()
  await pool.end()
}, 30_000)

describe('loop: relay and worker against the local engine', () => {
  it('an order reaches both subscribers and the command handler, tenant id unchanged (mandatory)', async () => {
    const tenantId = randomUUID()
    const placed = await placeOrder(pool, kinesin, { tenantId, customerId: randomUUID() })

    const recorded = await waitUntil(async () => {
      const result = await admin.query('SELECT recorded_at FROM shop_order WHERE id = $1', [placed.orderId])
      return result.rows[0]?.recorded_at != null
    }, 60_000)
    expect(recorded).toBe(true)

    const orderRow = await admin.query('SELECT tenant_id FROM shop_order WHERE id = $1', [placed.orderId])
    expect(orderRow.rows[0]?.tenant_id).toBe(tenantId)

    const invoiceSent = await waitUntil(async () => {
      const result = await admin.query('SELECT sent_at FROM shop_invoice WHERE id = $1', [placed.invoiceId])
      return result.rows[0]?.sent_at != null
    }, 60_000)
    expect(invoiceSent).toBe(true)

    // record-order and audit-order run on independent subscriptions with no
    // ordering between them or against send-invoice; poll until all three
    // log rows have landed instead of racing a single snapshot read.
    const allLogged = await waitUntil(async () => {
      const rows = await handlerLogRows([placed.envelopeIds.orderPlaced, placed.envelopeIds.sendInvoice])
      return ['record-order', 'audit-order', 'send-invoice'].every((name) => rows.some((row) => row.handler === name))
    }, 30_000)
    expect(allLogged).toBe(true)

    const rows = await handlerLogRows([placed.envelopeIds.orderPlaced, placed.envelopeIds.sendInvoice])
    const byHandler = (name: string): LogRow[] => rows.filter((row) => row.handler === name)
    expect(byHandler('record-order')).toHaveLength(1)
    expect(byHandler('audit-order')).toHaveLength(1)
    expect(byHandler('send-invoice')).toHaveLength(1)
    expect(rows.every((row) => row.tenant_id === tenantId)).toBe(true)
  }, 90_000)

  it('a re-shipped outbox row runs record-order once (mandatory)', async () => {
    const tenantId = randomUUID()
    const placed = await placeOrder(pool, kinesin, { tenantId, customerId: randomUUID() })
    const envelopeId = placed.envelopeIds.orderPlaced

    const recorded = await waitUntil(async () => {
      const result = await admin.query('SELECT recorded_at FROM shop_order WHERE id = $1', [placed.orderId])
      return result.rows[0]?.recorded_at != null
    }, 60_000)
    expect(recorded).toBe(true)

    await admin.query(
      'UPDATE kinesin_outbox SET published_at = NULL, claimed_at = NULL, claimed_by = NULL WHERE id = $1',
      [envelopeId],
    )

    const republished = await waitUntil(async () => {
      const result = await admin.query('SELECT published_at FROM kinesin_outbox WHERE id = $1', [envelopeId])
      return result.rows[0]?.published_at != null
    }, 30_000)
    expect(republished).toBe(true)

    // A further bounded window for the redelivered run to reach the handler
    // (or, if idempotency held, to not add a second row).
    await sleep(5_000)

    const processed = await admin.query(
      'SELECT count(*)::text AS count FROM kinesin_processed WHERE envelope_id = $1 AND handler = $2',
      [envelopeId, 'record-order'],
    )
    expect(processed.rows[0]?.count).toBe('1')

    const rows = await handlerLogRows([envelopeId])
    expect(rows.filter((row) => row.handler === 'record-order')).toHaveLength(1)
    expect(rows.filter((row) => row.handler === 'audit-order')).toHaveLength(1)
  }, 60_000)

  it('five invoice commands for one order are handled in publish order (mandatory)', async () => {
    const tenantId = randomUUID()
    const orderId = uuidv7()
    const invoiceIds = Array.from({ length: 5 }, () => uuidv7())

    await withTransaction(pool, async (tx) => {
      await tx.query('INSERT INTO shop_order (id, tenant_id, customer_id) VALUES ($1, $2, $3)', [
        orderId,
        tenantId,
        randomUUID(),
      ])
      for (const invoiceId of invoiceIds) {
        await tx.query('INSERT INTO shop_invoice (id, order_id, tenant_id) VALUES ($1, $2, $3)', [
          invoiceId,
          orderId,
          tenantId,
        ])
      }
    })

    // Five separate transactions, awaited in sequence: claimPendingRows
    // orders only by created_at with no tiebreaker, so five rows sharing one
    // transaction's created_at would leave their relative order undefined.
    for (const invoiceId of invoiceIds) {
      await withTransaction(pool, (tx) => kinesin.publish(tx, sendInvoice, { orderId, invoiceId }, { tenantId }))
    }

    const done = await waitUntil(async () => {
      const result = await admin.query(
        "SELECT count(*)::text AS count FROM shop_handler_log WHERE handler = 'send-invoice' AND order_id = $1",
        [orderId],
      )
      return Number(result.rows[0]?.count) >= invoiceIds.length
    }, 60_000)
    expect(done).toBe(true)

    // note carries the invoice id (handlers/sendInvoice.ts); its order across
    // the log's own seq column is the proof the FIFO key held under concurrency.
    const ordered = await admin.query(
      "SELECT note FROM shop_handler_log WHERE handler = 'send-invoice' AND order_id = $1 ORDER BY seq",
      [orderId],
    )
    expect(ordered.rows.map((row) => row.note)).toEqual(invoiceIds)
  }, 90_000)

  it('a command for a missing invoice fails once and is not retried (dead letter)', async () => {
    const tenantId = randomUUID()
    const orderId = uuidv7()
    const missingInvoiceId = uuidv7()

    const envelope = await withTransaction(pool, (tx) =>
      kinesin.publish(tx, sendInvoice, { orderId, invoiceId: missingInvoiceId }, { tenantId }),
    )

    const failed = await waitUntil(async () => {
      const result = await engine.runs.list({ additionalMetadata: { envelopeId: envelope.id } })
      return result.rows[0]?.status === 'FAILED'
    }, 60_000)
    expect(failed).toBe(true)

    const result = await engine.runs.list({ additionalMetadata: { envelopeId: envelope.id } })
    expect(result.rows[0]?.retryCount).toBe(0)

    const logRows = await admin.query('SELECT 1 FROM shop_handler_log WHERE envelope_id = $1', [envelope.id])
    expect(logRows.rows).toHaveLength(0)
  }, 90_000)

  it('orders placed with no worker running are handled once it starts', async () => {
    const stoppedCode = await worker.stop()
    expect(stoppedCode).toBe(0)

    const placedA = await placeOrder(pool, kinesin, { tenantId: randomUUID(), customerId: randomUUID() })
    const placedB = await placeOrder(pool, kinesin, { tenantId: randomUUID(), customerId: randomUUID() })
    const envelopeIds = [
      placedA.envelopeIds.orderPlaced,
      placedA.envelopeIds.sendInvoice,
      placedB.envelopeIds.orderPlaced,
      placedB.envelopeIds.sendInvoice,
    ]

    const published = await waitUntil(async () => {
      const result = await admin.query('SELECT published_at FROM kinesin_outbox WHERE id = ANY($1)', [envelopeIds])
      return result.rows.length === envelopeIds.length && result.rows.every((row) => row.published_at != null)
    }, 30_000)
    expect(published).toBe(true)

    worker = spawnProcess(WORKER_SCRIPT, childEnv())
    await worker.ready

    const handled = await waitUntil(async () => {
      const result = await admin.query('SELECT recorded_at FROM shop_order WHERE id = ANY($1)', [
        [placedA.orderId, placedB.orderId],
      ])
      return result.rows.length === 2 && result.rows.every((row) => row.recorded_at != null)
    }, 60_000)
    expect(handled).toBe(true)
  }, 120_000)
})
