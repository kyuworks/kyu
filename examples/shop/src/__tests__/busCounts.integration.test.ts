import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Kyu } from '@kyuworks/sdk'
import { uuidv7 } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ShopConfig } from '../config.js'
import { readConfig } from '../config.js'
import { createPool, withTransaction } from '../db/pool.js'
import { sendInvoice } from '../messages.js'
import { createShopKyu } from '../kyu.js'
import { placeOrder } from '../producer/placeOrder.js'
import { shipOrder } from '../producer/shipOrder.js'
import { buildSubscriptions } from '../subscriptions.js'
import type { BusCounts, SubscriptionRunCounts } from '../ui/busCounts.js'
import { readBusCounts } from '../ui/busCounts.js'
import type { BusTopology } from '../ui/busTopology.js'
import { describeBusTopology } from '../ui/busTopology.js'
import { handleUiRequest } from '../ui/handleRequest.js'
import { spawnProcess, stopAllSpawnedProcesses } from './processes.js'
import type { SpawnedProcess } from './processes.js'

// Drives the relay and worker as real child processes against the local
// engine and reads counts straight off the pool plus one kyu.runs.forEnvelope
// call per window envelope, proving readBusCounts's queries and engine fan-out
// against real rows, not fakes. The database is shared across every
// integration file in this suite, so every assertion below is a delta from a
// baseline taken at the top of each test, never an absolute total.
const RELAY_SCRIPT = path.resolve(import.meta.dirname, '../../dist/relay.js')
const WORKER_SCRIPT = path.resolve(import.meta.dirname, '../../dist/worker.js')
const namespace = `bc${randomBytes(3).toString('hex')}_`

let config: ShopConfig
let pool: Pool
let kyu: Kyu
let topology: BusTopology
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

function readCounts(): Promise<BusCounts> {
  return readBusCounts(pool, kyu.runs, topology)
}

const EMPTY_SUBSCRIPTION_COUNTS: Omit<SubscriptionRunCounts, 'name'> = {
  queued: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
}

// The label readProducerTotals coalesces a missing envelope source to, and the
// heading BusDiagram then draws ("Producer: (unknown)").
const UNKNOWN_SOURCE = '(unknown)'

function subscriptionCounts(counts: BusCounts, name: string): SubscriptionRunCounts {
  return (
    counts.subscriptions.find((subscription) => subscription.name === name) ?? { name, ...EMPTY_SUBSCRIPTION_COUNTS }
  )
}

function parkedCount(counts: BusCounts, name: string): number {
  return subscriptionCounts(counts, name).parked ?? 0
}

function doneOutcomeCount(counts: BusCounts, name: string, label: string): number {
  return subscriptionCounts(counts, name).doneOutcomes?.find((outcome) => outcome.label === label)?.count ?? 0
}

beforeAll(async () => {
  const base = readConfig()
  config = { ...base, namespace }
  pool = createPool(config.databaseUrl)
  kyu = createShopKyu(config)
  topology = describeBusTopology(buildSubscriptions(kyu, pool, config))

  relay = spawnProcess(RELAY_SCRIPT, childEnv())
  worker = spawnProcess(WORKER_SCRIPT, childEnv())
  await Promise.all([relay.ready, worker.ready])
}, 60_000)

// The order below ships before this file's own tests end, so no watch-shipping
// run is still parked when this runs (a parked run makes stop() wait per eviction).
afterAll(async () => {
  await stopAllSpawnedProcesses()
  await pool.end()
}, 90_000)

describe('readBusCounts: against the local engine', () => {
  it('moves outbox and run counts as an order is placed then shipped', async () => {
    const baseline = await readCounts()

    const tenantId = randomUUID()
    const placed = await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() })

    let afterPlace: BusCounts = baseline
    await waitUntil(
      async () => {
        afterPlace = await readCounts()
        return (
          subscriptionCounts(afterPlace, 'record-order').completed ===
            subscriptionCounts(baseline, 'record-order').completed + 1 &&
          subscriptionCounts(afterPlace, 'audit-order').completed ===
            subscriptionCounts(baseline, 'audit-order').completed + 1 &&
          subscriptionCounts(afterPlace, 'send-invoice').completed ===
            subscriptionCounts(baseline, 'send-invoice').completed + 1 &&
          parkedCount(afterPlace, 'watch-shipping') === parkedCount(baseline, 'watch-shipping') + 1
        )
      },
      60_000,
      () => `counts after placeOrder: ${JSON.stringify(afterPlace)}, baseline: ${JSON.stringify(baseline)}`,
    )

    // Two envelopes published (order placed, send invoice); both are shipped
    // once the relay has pushed them — this test never stops the relay.
    expect(afterPlace.outbox.shipped).toBe(baseline.outbox.shipped + 2)

    await shipOrder(pool, kyu, { tenantId, orderId: placed.orderId, carrier: 'ups' })

    let afterShip: BusCounts = afterPlace
    await waitUntil(
      async () => {
        afterShip = await readCounts()
        return (
          doneOutcomeCount(afterShip, 'watch-shipping', 'shipped') ===
            doneOutcomeCount(baseline, 'watch-shipping', 'shipped') + 1 &&
          parkedCount(afterShip, 'watch-shipping') === parkedCount(baseline, 'watch-shipping')
        )
      },
      60_000,
      () => `counts after shipOrder: ${JSON.stringify(afterShip)}, baseline: ${JSON.stringify(baseline)}`,
    )
  }, 180_000)

  // M1/M2: a message published while the relay is stopped only raises
  // "waiting for relay" — no run count moves. Once the relay runs again, it
  // moves to "shipped" and the runs appear under the subscriptions.
  it('moves only waiting-for-relay while the relay is stopped, then drains it and gains runs once restarted', async () => {
    const stoppedCode = await relay.stop()

    const baseline = await readCounts()
    const tenantId = randomUUID()
    const placed = await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() })

    // A failing assertion below must not leave the relay dead for the rest of
    // this file — every later test would then burn a 60s waitUntil timeout.
    try {
      expect(stoppedCode).toBe(0)

      const whileStopped = await readCounts()
      expect(whileStopped.outbox.waitingForRelay).toBe(baseline.outbox.waitingForRelay + 2)
      expect(whileStopped.outbox.shipped).toBe(baseline.outbox.shipped)
      for (const subscription of topology.subscriptions) {
        const before = subscriptionCounts(baseline, subscription.name)
        const after = subscriptionCounts(whileStopped, subscription.name)
        expect(
          [after.queued, after.running, after.completed, after.failed, after.cancelled],
          `subscription ${subscription.name} moved while the relay was stopped`,
        ).toEqual([before.queued, before.running, before.completed, before.failed, before.cancelled])
      }
    } finally {
      relay = spawnProcess(RELAY_SCRIPT, childEnv())
      await relay.ready
    }

    let afterRestart: BusCounts = baseline
    await waitUntil(
      async () => {
        afterRestart = await readCounts()
        return (
          afterRestart.outbox.waitingForRelay === baseline.outbox.waitingForRelay &&
          subscriptionCounts(afterRestart, 'record-order').completed >
            subscriptionCounts(baseline, 'record-order').completed &&
          subscriptionCounts(afterRestart, 'audit-order').completed >
            subscriptionCounts(baseline, 'audit-order').completed &&
          subscriptionCounts(afterRestart, 'send-invoice').completed >
            subscriptionCounts(baseline, 'send-invoice').completed
        )
      },
      60_000,
      () => `counts after relay restart: ${JSON.stringify(afterRestart)}, baseline: ${JSON.stringify(baseline)}`,
    )

    // Ship the order so its watch-shipping run does not stay parked past this
    // test — a parked run makes afterAll's stop() wait per eviction ack.
    await shipOrder(pool, kyu, { tenantId, orderId: placed.orderId, carrier: 'ups' })
    await waitUntil(
      async () => {
        const current = await readCounts()
        return (
          doneOutcomeCount(current, 'watch-shipping', 'shipped') >
          doneOutcomeCount(baseline, 'watch-shipping', 'shipped')
        )
      },
      60_000,
      () => 'watch-shipping never completed after shipping post-restart',
    )
  }, 180_000)

  // M4: watch-shipping parks while the order is unshipped, then returns to
  // baseline and the shipped label gains one once it ships.
  it('reports watch-shipping parked while the order is unshipped, then shipped once it ships', async () => {
    const baseline = await readCounts()
    const tenantId = randomUUID()
    const placed = await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() })

    await waitUntil(
      async () => parkedCount(await readCounts(), 'watch-shipping') === parkedCount(baseline, 'watch-shipping') + 1,
      60_000,
      () => 'watch-shipping never parked after placeOrder',
    )

    await shipOrder(pool, kyu, { tenantId, orderId: placed.orderId, carrier: 'fedex' })

    await waitUntil(
      async () => {
        const current = await readCounts()
        return (
          parkedCount(current, 'watch-shipping') === parkedCount(baseline, 'watch-shipping') &&
          doneOutcomeCount(current, 'watch-shipping', 'shipped') ===
            doneOutcomeCount(baseline, 'watch-shipping', 'shipped') + 1
        )
      },
      60_000,
      () => 'watch-shipping never returned to baseline parked and gained shipped',
    )
  }, 180_000)

  // M3: a command naming an invoice id with no row shows as exactly one
  // failed run in send-invoice, and never moves send-invoice's done count.
  it('shows a command for a missing invoice as one failed run in send-invoice, never done', async () => {
    const baseline = await readCounts()
    const tenantId = randomUUID()
    const orderId = uuidv7()
    const missingInvoiceId = uuidv7()

    await withTransaction(pool, (tx) =>
      kyu.publish(tx, sendInvoice, { orderId, invoiceId: missingInvoiceId }, { tenantId }),
    )

    await waitUntil(
      async () =>
        subscriptionCounts(await readCounts(), 'send-invoice').failed ===
        subscriptionCounts(baseline, 'send-invoice').failed + 1,
      60_000,
      () => 'send-invoice never gained a failed run for the missing invoice',
    )

    const afterFailure = await readCounts()
    expect(subscriptionCounts(afterFailure, 'send-invoice').failed).toBe(
      subscriptionCounts(baseline, 'send-invoice').failed + 1,
    )
    expect(subscriptionCounts(afterFailure, 'send-invoice').completed).toBe(
      subscriptionCounts(baseline, 'send-invoice').completed,
    )
  }, 90_000)

  // The relay only retires a row after three claims and a re-claim needs the
  // 300 s stale window, so this inserts the row already retired. The claim skips
  // dead_at rows, so the running relay never touches it.
  it('never counts a retired outbox row as waiting, and reports it under retired', async () => {
    const baseline = await readCounts()
    const retiredId = uuidv7()
    try {
      await pool.query(
        `INSERT INTO kyu_outbox (id, name, tenant_id, envelope, published_at, dead_at, attempts, last_error)
         VALUES ($1, 'shop.order.legacy', NULL, $2::jsonb, NULL, now(), 3, 'envelope: invalid')`,
        [retiredId, JSON.stringify({ name: 'shop.order.legacy', source: 'shop' })],
      )
      const afterRetire = await readCounts()
      expect(afterRetire.outbox.waitingForRelay).toBe(baseline.outbox.waitingForRelay)
      expect(afterRetire.outbox.retired).toBe(baseline.outbox.retired + 1)
      expect(afterRetire.outbox.published).toBe(baseline.outbox.published + 1)
      expect(afterRetire.outbox.shipped).toBe(baseline.outbox.shipped)
      expect(afterRetire.outbox.published).toBe(
        afterRetire.outbox.waitingForRelay + afterRetire.outbox.shipped + afterRetire.outbox.retired,
      )
    } finally {
      await pool.query('DELETE FROM kyu_outbox WHERE id = $1', [retiredId])
    }
  }, 60_000)

  // #120: the relay retires exactly the rows whose envelope failed the contract,
  // and a missing `source` is the likeliest failure. This goes through the real
  // route, because the 500 was produced by handleBusJson's catch, not by the query.
  it('serves /bus.json with 200 and an (unknown) producer for a retired row whose envelope has only a name', async () => {
    const baseline = await readCounts()
    const baselineUnknown = baseline.producers.find((producer) => producer.source === UNKNOWN_SOURCE)?.published ?? 0
    const retiredId = uuidv7()
    try {
      await pool.query(
        `INSERT INTO kyu_outbox (id, name, tenant_id, envelope, published_at, dead_at, attempts, last_error)
         VALUES ($1, 'shop.order.legacy', NULL, $2::jsonb, NULL, now(), 3, 'envelope: invalid')`,
        [retiredId, JSON.stringify({ name: 'shop.order.legacy' })],
      )

      const response = await handleUiRequest(
        { pool, kyu, dashboardUrl: 'http://localhost:8888', topology, readWeb: () => Promise.resolve(undefined) },
        { method: 'GET', url: '/bus.json', contentType: '', body: '' },
      )

      expect(response.status).toBe(200)
      const parsed: { counts: BusCounts } = JSON.parse(response.body)
      expect(parsed.counts.producers.find((producer) => producer.source === UNKNOWN_SOURCE)?.published).toBe(
        baselineUnknown + 1,
      )
      expect(parsed.counts.outbox.retired).toBe(baseline.outbox.retired + 1)
      expect(parsed.counts.outbox.waitingForRelay).toBe(baseline.outbox.waitingForRelay)
    } finally {
      await pool.query('DELETE FROM kyu_outbox WHERE id = $1', [retiredId])
    }
  }, 60_000)
})
