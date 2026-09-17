import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Kinesin } from '@kinesin/sdk'
import { Client } from 'pg'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlaygroundConfig } from '../config.js'
import { readConfig } from '../config.js'
import { createPool } from '../db/pool.js'
import { createPlaygroundKinesin } from '../kinesin.js'
import { placeOrder } from '../producer/placeOrder.js'
import { shipOrder } from '../producer/shipOrder.js'
import { spawnProcess, stopAllSpawnedProcesses } from './processes.js'
import type { SpawnedProcess } from './processes.js'

// Drives the durable watch-shipping handler as a real worker process,
// restarting it mid-wait: the only honest way to prove a durable run
// survives a process restart (loop.integration.test.ts's own convention;
// see example-app-testing.md § 1).
const RELAY_SCRIPT = path.resolve(import.meta.dirname, '../../dist/relay.js')
const WORKER_SCRIPT = path.resolve(import.meta.dirname, '../../dist/worker.js')
const namespace = `rs${randomBytes(3).toString('hex')}_`

let config: PlaygroundConfig
let pool: Pool
let kinesin: Kinesin
let admin: Client
let relay: SpawnedProcess

function childEnv(watchTimeout?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KINESIN_EXAMPLE_DATABASE_URL: config.databaseUrl,
    KINESIN_EXAMPLE_NAMESPACE: namespace,
  }
  if (watchTimeout !== undefined) env['KINESIN_EXAMPLE_WATCH_TIMEOUT'] = watchTimeout
  return env
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

interface WatchLogRow {
  handler: string
  note: string | null
  pid: number | null
}

async function watchLogRows(envelopeId: string): Promise<WatchLogRow[]> {
  const result = await admin.query<WatchLogRow>(
    "SELECT handler, note, pid FROM shop_handler_log WHERE envelope_id = $1 AND handler LIKE 'watch-shipping:%' ORDER BY seq",
    [envelopeId],
  )
  return result.rows
}

async function hasRow(envelopeId: string, handler: string): Promise<boolean> {
  const rows = await watchLogRows(envelopeId)
  return rows.some((row) => row.handler === handler)
}

beforeAll(async () => {
  const base = readConfig()
  config = { ...base, namespace }
  pool = createPool(config.databaseUrl)
  kinesin = createPlaygroundKinesin(config)
  admin = new Client({ connectionString: config.databaseUrl })
  await admin.connect()

  relay = spawnProcess(RELAY_SCRIPT, childEnv())
  await relay.ready
}, 60_000)

afterAll(async () => {
  await stopAllSpawnedProcesses()
  await admin.end()
  await pool.end()
}, 30_000)

describe('restart: the durable watch-shipping handler', () => {
  it('completes when the order ships during the wait', async () => {
    const tenantId = randomUUID()
    const worker = spawnProcess(WORKER_SCRIPT, childEnv())
    await worker.ready

    try {
      const placed = await placeOrder(pool, kinesin, { tenantId, customerId: randomUUID() })
      const envelopeId = placed.envelopeIds.orderPlaced

      const waiting = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:waiting'), 60_000)
      expect(waiting).toBe(true)

      await sleep(2_000)
      const carrier = 'ups'
      await shipOrder(pool, kinesin, { tenantId, orderId: placed.orderId, carrier })

      const completed = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:completed'), 90_000)
      expect(completed).toBe(true)

      const rows = await watchLogRows(envelopeId)
      const completedRow = rows.find((row) => row.handler === 'watch-shipping:completed')
      expect(completedRow?.note).toBe(carrier)

      const orderRow = await admin.query('SELECT shipped_at FROM shop_order WHERE id = $1', [placed.orderId])
      expect(orderRow.rows[0]?.shipped_at).not.toBeNull()
    } finally {
      await worker.stop()
    }
  }, 180_000)

  it('records a timeout when nothing ships', async () => {
    const tenantId = randomUUID()
    const worker = spawnProcess(WORKER_SCRIPT, childEnv('20s'))
    await worker.ready

    try {
      const placed = await placeOrder(pool, kinesin, { tenantId, customerId: randomUUID() })
      const envelopeId = placed.envelopeIds.orderPlaced

      const timedOut = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:timeout'), 60_000)
      expect(timedOut).toBe(true)

      const orderRow = await admin.query('SELECT shipped_at FROM shop_order WHERE id = $1', [placed.orderId])
      expect(orderRow.rows[0]?.shipped_at).toBeNull()
    } finally {
      await worker.stop()
    }
  }, 180_000)

  it('a wrong-tenant shipment never matches; the wait times out', async () => {
    const tenantId = randomUUID()
    const otherTenantId = randomUUID()
    const worker = spawnProcess(WORKER_SCRIPT, childEnv('20s'))
    await worker.ready

    try {
      const placed = await placeOrder(pool, kinesin, { tenantId, customerId: randomUUID() })
      const envelopeId = placed.envelopeIds.orderPlaced

      const waiting = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:waiting'), 60_000)
      expect(waiting).toBe(true)

      await shipOrder(pool, kinesin, { tenantId: otherTenantId, orderId: placed.orderId, carrier: 'dhl' })

      const timedOut = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:timeout'), 60_000)
      expect(timedOut).toBe(true)

      const orderRow = await admin.query('SELECT shipped_at FROM shop_order WHERE id = $1', [placed.orderId])
      expect(orderRow.rows[0]?.shipped_at).toBeNull()
    } finally {
      await worker.stop()
    }
  }, 180_000)

  it('a parked run completes in a new worker process after a restart (headline)', async () => {
    const tenantId = randomUUID()
    const workerA = spawnProcess(WORKER_SCRIPT, childEnv())
    await workerA.ready
    const workerAPid = workerA.child.pid

    const placed = await placeOrder(pool, kinesin, { tenantId, customerId: randomUUID() })
    const envelopeId = placed.envelopeIds.orderPlaced

    // The run is now sleeping or parked in waitFor: either way it has been
    // evicted from worker A's process, which is the state a restart must survive.
    const waiting = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:waiting'), 60_000)
    expect(waiting).toBe(true)

    const exitCodeA = await workerA.stop()
    expect(exitCodeA, `worker A (pid ${String(workerAPid)}) did not exit cleanly`).toBe(0)
    expect(workerA.child.exitCode, 'no worker A process should still be running').not.toBeNull()

    // The relay stays up, so the event reaches the engine while no worker runs.
    const carrier = 'fedex'
    await shipOrder(pool, kinesin, { tenantId, orderId: placed.orderId, carrier })

    const workerB = spawnProcess(WORKER_SCRIPT, childEnv())
    await workerB.ready
    const workerBPid = workerB.child.pid

    try {
      const completed = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:completed'), 120_000)
      expect(
        completed,
        `worker A pid ${String(workerAPid)}, worker B pid ${String(workerBPid)}: no completed row`,
      ).toBe(true)

      const rows = await watchLogRows(envelopeId)
      expect(
        rows.filter((row) => row.handler === 'watch-shipping:waiting'),
        'exactly one waiting row',
      ).toHaveLength(1)
      const completedRows = rows.filter((row) => row.handler === 'watch-shipping:completed')
      expect(completedRows, 'exactly one completed row').toHaveLength(1)

      expect(
        completedRows[0]?.pid,
        `completed row pid must equal worker B's pid ${String(workerBPid)}, not worker A's pid ${String(workerAPid)}`,
      ).toBe(workerBPid)
    } finally {
      await workerB.stop()
    }
  }, 180_000)
})
