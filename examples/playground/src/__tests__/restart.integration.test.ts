import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { HatchetClient, Qtaxis } from '@qtaxis/sdk'
import { createHatchetClient } from '@qtaxis/sdk'
import { Client } from 'pg'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlaygroundConfig } from '../config.js'
import { readConfig } from '../config.js'
import { createPool } from '../db/pool.js'
import { createPlaygroundQtaxis } from '../qtaxis.js'
import { placeOrder } from '../producer/placeOrder.js'
import { shipOrder } from '../producer/shipOrder.js'
import { spawnProcess, stopAllSpawnedProcesses } from './processes.js'
import type { SpawnedProcess } from './processes.js'

// Drives the durable watch-shipping handler as a real worker process,
// restarting it mid-wait: a killed process is the only honest way to prove
// a durable run survives a restart. Every test gets its own namespace, relay
// and worker(s) (startPlayground below) so a worker one test leaves running
// can never pick up a run that belongs to a different test.
const RELAY_SCRIPT = path.resolve(import.meta.dirname, '../../dist/relay.js')
const WORKER_SCRIPT = path.resolve(import.meta.dirname, '../../dist/worker.js')

let baseConfig: PlaygroundConfig
let pool: Pool
let qtaxis: Qtaxis
let admin: Client

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

// A bare boolean assertion on a waitUntil() result gives no reason it never
// happened. This reports the engine's own view of the run (through this
// test's dedicated namespaced client) so a failure names the run status
// instead of leaving it to log archaeology.
async function expectEventually(
  engine: HatchetClient,
  envelopeId: string,
  label: string,
  found: boolean,
): Promise<void> {
  if (found) return
  const runs = await engine.runs.list({ additionalMetadata: { envelopeId } })
  throw new Error(
    `${label} never happened for envelope ${envelopeId}; engine run status: ${JSON.stringify(runs.rows[0] ?? null)}`,
  )
}

interface Playground {
  namespace: string
  engine: HatchetClient
  relay: SpawnedProcess
  spawnWorker(): Promise<SpawnedProcess>
  stopAll(): Promise<void>
}

// One namespace, one relay, per test. Every worker a test spawns shares this
// namespace and this one watch timeout (config.ts's QTAXIS_EXAMPLE_WATCH_TIMEOUT):
// a run parked by a worker on one timeout and replayed by a worker on another
// fails with a non-determinism error, since the timeout is read inside the
// durable body and becomes part of the recorded wait.
async function startPlayground(watchTimeout?: string): Promise<Playground> {
  const namespace = `playground_${randomBytes(4).toString('hex')}_`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QTAXIS_EXAMPLE_DATABASE_URL: baseConfig.databaseUrl,
    QTAXIS_EXAMPLE_NAMESPACE: namespace,
  }
  if (watchTimeout !== undefined) env['QTAXIS_EXAMPLE_WATCH_TIMEOUT'] = watchTimeout

  const engine = createHatchetClient({ namespace })
  const relay = spawnProcess(RELAY_SCRIPT, env)
  const workers: SpawnedProcess[] = []
  await relay.ready

  return {
    namespace,
    engine,
    relay,
    async spawnWorker() {
      const worker = spawnProcess(WORKER_SCRIPT, env)
      workers.push(worker)
      await worker.ready
      return worker
    },
    async stopAll() {
      await Promise.all([relay.stop(), ...workers.map((worker) => worker.stop())])
    },
  }
}

beforeAll(async () => {
  baseConfig = readConfig()
  pool = createPool(baseConfig.databaseUrl)
  // publish()/onceById() only ever touch Postgres (never the engine), so one
  // shared client is fine for placeOrder/shipOrder across every test below.
  qtaxis = createPlaygroundQtaxis(baseConfig)
  admin = new Client({ connectionString: baseConfig.databaseUrl })
  await admin.connect()
}, 60_000)

afterAll(async () => {
  await stopAllSpawnedProcesses()
  await admin.end()
  await pool.end()
}, 30_000)

describe('restart: the durable watch-shipping handler', () => {
  it('completes when the order ships during the wait', async () => {
    const tenantId = randomUUID()
    const playground = await startPlayground()
    try {
      await playground.spawnWorker()

      const placed = await placeOrder(pool, qtaxis, { tenantId, customerId: randomUUID() })
      const envelopeId = placed.envelopeIds.orderPlaced

      const waiting = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:waiting'), 60_000)
      await expectEventually(playground.engine, envelopeId, 'watch-shipping:waiting row', waiting)

      await sleep(2_000)
      const carrier = 'ups'
      await shipOrder(pool, qtaxis, { tenantId, orderId: placed.orderId, carrier })

      const completed = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:completed'), 90_000)
      await expectEventually(playground.engine, envelopeId, 'watch-shipping:completed row', completed)

      const rows = await watchLogRows(envelopeId)
      const completedRow = rows.find((row) => row.handler === 'watch-shipping:completed')
      expect(completedRow?.note).toBe(carrier)

      const orderRow = await admin.query('SELECT shipped_at FROM shop_order WHERE id = $1', [placed.orderId])
      expect(orderRow.rows[0]?.shipped_at).not.toBeNull()
    } finally {
      await playground.stopAll()
    }
  }, 180_000)

  it('records a timeout when nothing ships', async () => {
    const tenantId = randomUUID()
    const playground = await startPlayground('20s')
    try {
      await playground.spawnWorker()

      const placed = await placeOrder(pool, qtaxis, { tenantId, customerId: randomUUID() })
      const envelopeId = placed.envelopeIds.orderPlaced

      const timedOut = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:timeout'), 60_000)
      await expectEventually(playground.engine, envelopeId, 'watch-shipping:timeout row', timedOut)

      const orderRow = await admin.query('SELECT shipped_at FROM shop_order WHERE id = $1', [placed.orderId])
      expect(orderRow.rows[0]?.shipped_at).toBeNull()
    } finally {
      await playground.stopAll()
    }
  }, 180_000)

  it('a wrong-tenant shipment never matches; the wait times out', async () => {
    const tenantId = randomUUID()
    const otherTenantId = randomUUID()
    const playground = await startPlayground('20s')
    try {
      await playground.spawnWorker()

      const placed = await placeOrder(pool, qtaxis, { tenantId, customerId: randomUUID() })
      const envelopeId = placed.envelopeIds.orderPlaced

      const waiting = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:waiting'), 60_000)
      await expectEventually(playground.engine, envelopeId, 'watch-shipping:waiting row', waiting)

      await shipOrder(pool, qtaxis, { tenantId: otherTenantId, orderId: placed.orderId, carrier: 'dhl' })

      const timedOut = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:timeout'), 60_000)
      await expectEventually(playground.engine, envelopeId, 'watch-shipping:timeout row', timedOut)

      const orderRow = await admin.query('SELECT shipped_at FROM shop_order WHERE id = $1', [placed.orderId])
      expect(orderRow.rows[0]?.shipped_at).toBeNull()
    } finally {
      await playground.stopAll()
    }
  }, 180_000)

  it('a parked run completes in a new worker process after a restart (headline)', async () => {
    const tenantId = randomUUID()
    const playground = await startPlayground()
    try {
      const workerA = await playground.spawnWorker()
      const workerAPid = workerA.child.pid

      const placed = await placeOrder(pool, qtaxis, { tenantId, customerId: randomUUID() })
      const envelopeId = placed.envelopeIds.orderPlaced

      const waiting = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:waiting'), 60_000)
      await expectEventually(
        playground.engine,
        envelopeId,
        `watch-shipping:waiting row (worker A pid ${String(workerAPid)})`,
        waiting,
      )

      // The waiting row lands before sleepFor('5s'), while the handler body is
      // still executing -- not yet the parked state a restart must survive.
      // The engine's run summary has no separate "parked" status to poll for
      // that: V1TaskStatus is PENDING/RUNNING/COMPLETED/FAILED/CANCELLED, and
      // its isEvicted flag only flips once eviction is requested, which for a
      // task with no evictionPolicy configured happens only inside the very
      // shutdown sweep workerA.stop() below triggers -- it cannot be polled as
      // a readiness signal beforehand. Waiting past the sleep is the honest
      // proxy (see the "survives a stop during execution" test below for what
      // killing during that sleep actually does).
      await sleep(8_000)

      const exitCodeA = await workerA.stop()
      expect(
        workerA.child.signalCode,
        `worker A (pid ${String(workerAPid)}) should stop via SIGTERM, not be killed`,
      ).not.toBe('SIGKILL')
      expect(exitCodeA, `worker A (pid ${String(workerAPid)}) did not exit cleanly`).toBe(0)
      expect(workerA.child.exitCode, 'no worker A process should still be running').not.toBeNull()

      // The relay stays up, so the event reaches the engine while no worker runs.
      const carrier = 'fedex'
      await shipOrder(pool, qtaxis, { tenantId, orderId: placed.orderId, carrier })

      const workerB = await playground.spawnWorker()
      const workerBPid = workerB.child.pid

      const completed = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:completed'), 120_000)
      await expectEventually(
        playground.engine,
        envelopeId,
        `watch-shipping:completed row (worker A pid ${String(workerAPid)}, worker B pid ${String(workerBPid)})`,
        completed,
      )

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
      await playground.stopAll()
    }
  }, 180_000)

  it('survives a stop during execution', async () => {
    const tenantId = randomUUID()
    const playground = await startPlayground()
    try {
      const workerA = await playground.spawnWorker()
      const workerAPid = workerA.child.pid

      const placed = await placeOrder(pool, qtaxis, { tenantId, customerId: randomUUID() })
      const envelopeId = placed.envelopeIds.orderPlaced

      // The old (wrong) headline timing, on purpose: stop worker A the instant
      // the waiting row appears, which is during sleepFor('5s') while the body
      // is still executing. That attempt fails with "DurableListener stopped";
      // watchShipping.ts's retries makes the engine redeliver it to worker B.
      // Every write goes through onceById, so the replayed attempt is safe.
      const waiting = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:waiting'), 60_000)
      await expectEventually(
        playground.engine,
        envelopeId,
        `watch-shipping:waiting row (worker A pid ${String(workerAPid)})`,
        waiting,
      )

      await workerA.stop()

      const carrier = 'ups'
      await shipOrder(pool, qtaxis, { tenantId, orderId: placed.orderId, carrier })

      const workerB = await playground.spawnWorker()
      const workerBPid = workerB.child.pid

      const completed = await waitUntil(() => hasRow(envelopeId, 'watch-shipping:completed'), 120_000)
      await expectEventually(
        playground.engine,
        envelopeId,
        `watch-shipping:completed row (worker A pid ${String(workerAPid)}, worker B pid ${String(workerBPid)})`,
        completed,
      )

      const rows = await watchLogRows(envelopeId)
      const completedRows = rows.filter((row) => row.handler === 'watch-shipping:completed')
      expect(completedRows, 'exactly one completed row').toHaveLength(1)
      expect(completedRows[0]?.pid, `completed row pid must equal worker B's pid ${String(workerBPid)}`).toBe(
        workerBPid,
      )
    } finally {
      await playground.stopAll()
    }
  }, 180_000)
})
