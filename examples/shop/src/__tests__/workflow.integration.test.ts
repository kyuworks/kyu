import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Kyu } from '@kyuworks/sdk'
import { Client } from 'pg'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ShopConfig } from '../config.js'
import { readConfig } from '../config.js'
import { createPool, withTransaction } from '../db/pool.js'
import { createShopKyu } from '../kyu.js'
import { placeOrder } from '../producer/placeOrder.js'
import { triggerWorkflowOn } from '../producer/triggerWorkflow.js'
import { insertNewVersion, insertStepIdCollisionDefinition, insertWorkflowDefinition } from './workflowFixtures.js'
import type { InsertedDefinition } from './workflowFixtures.js'
import { spawnProcess, stopAllSpawnedProcesses } from './processes.js'
import type { SpawnedProcess } from './processes.js'

// Drives run-workflow as a real worker process, the same restart harness
// restart.integration.test.ts uses for watch-shipping: every test gets its
// own namespace, relay and worker(s) so a worker one test leaves running can
// never pick up a run from a different test. startShop below fixes
// KYU_SHOP_WATCH_TIMEOUT at '8s' for every worker it spawns: watch-shipping
// also fires on order placed and would hold a durable slot for minutes on
// its 3-minute default, and a mixed value across two workers of one parked
// run is the non-determinism trap (durable.ts).
const RELAY_SCRIPT = path.resolve(import.meta.dirname, '../../dist/relay.js')
const WORKER_SCRIPT = path.resolve(import.meta.dirname, '../../dist/worker.js')

let baseConfig: ShopConfig
let pool: Pool
let kyu: Kyu
let admin: Client

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}

interface StepLogRow {
  step_id: string
  kind: string
  exit_step_id: string | null
  tenant_id: string
  at: Date
}

async function stepLogRows(runId: string): Promise<StepLogRow[]> {
  const result = await admin.query<StepLogRow>(
    'SELECT step_id, kind, exit_step_id, tenant_id, at FROM shop_workflow_step_log WHERE run_id = $1 ORDER BY at',
    [runId],
  )
  return result.rows
}

async function findRunId(tenantId: string, orderId: string): Promise<string | null> {
  const result = await admin.query<{ run_id: string }>(
    'SELECT run_id FROM shop_workflow_run WHERE tenant_id = $1 AND order_id = $2',
    [tenantId, orderId],
  )
  return result.rows[0]?.run_id ?? null
}

interface RunRow {
  version_id: string
  tenant_id: string
  finished_at: Date | null
}

async function runRow(runId: string): Promise<RunRow | null> {
  const result = await admin.query<RunRow>(
    'SELECT version_id, tenant_id, finished_at FROM shop_workflow_run WHERE run_id = $1',
    [runId],
  )
  return result.rows[0] ?? null
}

interface NotifyLogRow {
  note: string | null
  pid: number | null
  tenant_id: string
}

async function notifyLogRows(orderId: string): Promise<NotifyLogRow[]> {
  const result = await admin.query<NotifyLogRow>(
    "SELECT note, pid, tenant_id FROM shop_handler_log WHERE handler = 'notify-staff' AND order_id = $1 ORDER BY seq",
    [orderId],
  )
  return result.rows
}

interface Shop {
  spawnWorker(): Promise<SpawnedProcess>
  stopAll(): Promise<void>
}

// One namespace, one relay, per test, exactly like restart.integration.test.ts's
// own startShop; the watch timeout is fixed at '8s' by every caller here.
async function startShop(): Promise<Shop> {
  const namespace = `wf_${randomBytes(4).toString('hex')}_`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KYU_SHOP_DATABASE_URL: baseConfig.databaseUrl,
    KYU_SHOP_NAMESPACE: namespace,
    KYU_SHOP_WATCH_TIMEOUT: '8s',
  }
  const relay = spawnProcess(RELAY_SCRIPT, env)
  const workers: SpawnedProcess[] = []
  await relay.ready

  return {
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
  kyu = createShopKyu(baseConfig)
  admin = new Client({ connectionString: baseConfig.databaseUrl })
  await admin.connect()
}, 60_000)

afterAll(async () => {
  await stopAllSpawnedProcesses()
  await admin.end()
  await pool.end()
}, 30_000)

describe('run-workflow: walking a stored definition', () => {
  // The run row commits and the very next statement is sleepFor, so by the
  // time this test can observe the run row and stop worker A, the run is
  // already parked in wait-a-bit, not executing. The other half — a worker
  // stopping while the handler body is still running, which fails that
  // attempt with WorkerStoppingError and retries onto the next worker — is
  // proven once, at the SDK level, by durable.integration.test.ts's "stops
  // worker A without hanging and completes on worker B with no retries set
  // by the caller"; this file does not repeat it.
  it('a run parked in its first delay finishes on the next worker', async () => {
    const tenantId = randomUUID()
    await insertWorkflowDefinition(admin, tenantId)
    const shop = await startShop()
    try {
      const workerA = await shop.spawnWorker()

      const placed = await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() })

      const appeared = await waitUntil(() => findRunId(tenantId, placed.orderId).then((id) => id !== null), 60_000)
      expect(appeared, 'run row never appeared').toBe(true)
      const runId = await findRunId(tenantId, placed.orderId)
      if (runId === null) throw new Error('run row disappeared')

      await workerA.stop()

      const workerB = await shop.spawnWorker()
      const workerBPid = workerB.child.pid

      const finished = await waitUntil(async () => (await runRow(runId))?.finished_at != null, 90_000)
      expect(finished, 'run never finished').toBe(true)

      const rows = await stepLogRows(runId)
      expect(rows.map((row) => row.step_id)).toEqual(['wait-a-bit', 'shipped-yet', 'settle', 'nudge', 'finish'])
      for (const row of rows) expect(row.tenant_id).toBe(tenantId)

      // The run finishing only means run-workflow's own transaction
      // committed the notify command to kyu_outbox; the relay still has to
      // ship it and notify-staff still has to process it.
      const notified = await waitUntil(async () => (await notifyLogRows(placed.orderId)).length > 0, 60_000)
      expect(notified, 'notify-staff log row never appeared').toBe(true)
      const notifyRows = await notifyLogRows(placed.orderId)
      expect(notifyRows).toHaveLength(1)
      expect(notifyRows[0]?.tenant_id).toBe(tenantId)
      expect(notifyRows[0]?.pid).toBe(workerBPid)

      const run = await runRow(runId)
      expect(run?.tenant_id).toBe(tenantId)
    } finally {
      await shop.stopAll()
    }
  }, 180_000)

  it('a replay reuses the recorded branch exit, it does not evaluate it again', async () => {
    const tenantId = randomUUID()
    await insertWorkflowDefinition(admin, tenantId)
    const shop = await startShop()
    try {
      const workerA = await shop.spawnWorker()

      const placed = await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() })

      const appeared = await waitUntil(() => findRunId(tenantId, placed.orderId).then((id) => id !== null), 60_000)
      expect(appeared, 'run row never appeared').toBe(true)
      const runId = await findRunId(tenantId, placed.orderId)
      if (runId === null) throw new Error('run row disappeared')

      const branchDecided = await waitUntil(
        async () => (await stepLogRows(runId)).some((row) => row.step_id === 'shipped-yet'),
        60_000,
      )
      expect(branchDecided, 'shipped-yet ledger row never appeared').toBe(true)

      // Direct write, not shipOrder(): the order has not shipped when the
      // branch decides, so its exit is 'settle'. Marking it shipped now,
      // after the decision, must not change the exit a replay reuses.
      await admin.query('UPDATE shop_order SET shipped_at = now() WHERE id = $1', [placed.orderId])

      await workerA.stop()

      const workerB = await shop.spawnWorker()
      const workerBPid = workerB.child.pid

      const finished = await waitUntil(async () => (await runRow(runId))?.finished_at != null, 90_000)
      expect(finished, 'run never finished').toBe(true)

      const rows = await stepLogRows(runId)
      expect(rows.map((row) => row.step_id)).toEqual(['wait-a-bit', 'shipped-yet', 'settle', 'nudge', 'finish'])
      expect(rows.find((row) => row.step_id === 'shipped-yet')?.exit_step_id).toBe('settle')

      const notified = await waitUntil(async () => (await notifyLogRows(placed.orderId)).length > 0, 60_000)
      expect(notified, 'notify-staff log row never appeared').toBe(true)
      const notifyRows = await notifyLogRows(placed.orderId)
      expect(notifyRows).toHaveLength(1)
      expect(notifyRows[0]?.pid).toBe(workerBPid)
    } finally {
      await shop.stopAll()
    }
  }, 180_000)

  it('a run walks the version it started with', async () => {
    const tenantId = randomUUID()
    const definition: InsertedDefinition = await insertWorkflowDefinition(admin, tenantId)
    const shop = await startShop()
    try {
      const workerA = await shop.spawnWorker()

      const placed = await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() })

      const appeared = await waitUntil(() => findRunId(tenantId, placed.orderId).then((id) => id !== null), 60_000)
      expect(appeared, 'run row never appeared').toBe(true)
      const runId = await findRunId(tenantId, placed.orderId)
      if (runId === null) throw new Error('run row disappeared')

      // Still parked in wait-a-bit (3s delay): save version 2 with different
      // wording and repoint current_version_id while the run sleeps.
      await insertNewVersion(admin, definition, tenantId, {
        waitSeconds: 3,
        settleSeconds: 5,
        notifyText: 'version 2 text: should never be sent',
      })

      // Force an actual replay: without this, loadPinnedVersion only ever
      // runs once, before version 2 exists, and the test would pass even if
      // the interpreter re-read shop_workflow_definition.current_version_id.
      await workerA.stop()
      await shop.spawnWorker()

      const finished = await waitUntil(async () => (await runRow(runId))?.finished_at != null, 90_000)
      expect(finished, 'run never finished').toBe(true)

      const run = await runRow(runId)
      expect(run?.version_id).toBe(definition.versionId)

      const notified = await waitUntil(async () => (await notifyLogRows(placed.orderId)).length > 0, 60_000)
      expect(notified, 'notify-staff log row never appeared').toBe(true)
      const notifyRows = await notifyLogRows(placed.orderId)
      expect(notifyRows).toHaveLength(1)
      expect(notifyRows[0]?.note).toBe('Order has not shipped yet — please chase the warehouse.')
    } finally {
      await shop.stopAll()
    }
  }, 180_000)

  it('a shipped order ends without a notify', async () => {
    const tenantId = randomUUID()
    await insertWorkflowDefinition(admin, tenantId)
    const shop = await startShop()
    try {
      await shop.spawnWorker()

      const placed = await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() })

      const appeared = await waitUntil(() => findRunId(tenantId, placed.orderId).then((id) => id !== null), 60_000)
      expect(appeared, 'run row never appeared').toBe(true)
      const runId = await findRunId(tenantId, placed.orderId)
      if (runId === null) throw new Error('run row disappeared')

      // Inside the 3s wait-a-bit delay: shipping now means the branch reads true.
      await admin.query('UPDATE shop_order SET shipped_at = now() WHERE id = $1', [placed.orderId])

      const finished = await waitUntil(async () => (await runRow(runId))?.finished_at != null, 60_000)
      expect(finished, 'run never finished').toBe(true)

      const rows = await stepLogRows(runId)
      expect(rows.map((row) => row.step_id)).toEqual(['wait-a-bit', 'shipped-yet', 'finish'])
      expect(rows.find((row) => row.step_id === 'shipped-yet')?.exit_step_id).toBe('finish')

      expect(await notifyLogRows(placed.orderId)).toHaveLength(0)
    } finally {
      await shop.stopAll()
    }
  }, 180_000)

  it('two runs for one order do not interleave', async () => {
    const tenantId = randomUUID()
    const shop = await startShop()
    try {
      await shop.spawnWorker()

      // placeOrder runs before any definition is enabled, so it triggers no
      // run of its own; only the two explicit triggerWorkflowOn calls below do.
      const placed = await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() })
      await insertWorkflowDefinition(admin, tenantId)

      const first = await withTransaction(pool, (client) =>
        triggerWorkflowOn(client, kyu, { tenantId, orderId: placed.orderId }),
      )
      const second = await withTransaction(pool, (client) =>
        triggerWorkflowOn(client, kyu, { tenantId, orderId: placed.orderId }),
      )
      if (first === null || second === null) throw new Error('no definition was enabled for the trigger')

      const secondFinished = await waitUntil(async () => (await runRow(second.runId))?.finished_at != null, 120_000)
      expect(secondFinished, 'second run never finished').toBe(true)

      const firstRun = await runRow(first.runId)
      const secondFirstStep = (await stepLogRows(second.runId)).find((row) => row.step_id === 'wait-a-bit')

      expect(firstRun?.finished_at, 'first run never finished').not.toBeNull()
      expect(secondFirstStep, "second run's wait-a-bit row never appeared").toBeDefined()
      if (firstRun?.finished_at == null || secondFirstStep === undefined) throw new Error('unreachable')
      expect(firstRun.finished_at.getTime()).toBeLessThan(secondFirstStep.at.getTime())
    } finally {
      await shop.stopAll()
    }
  }, 180_000)

  // stepIdSchema allows a step literally named "start"; a run-start guard
  // keyed the same way as a step guard would collide with it and silently
  // skip that step's own effect (here, the notify never publishes).
  it('a step literally named "start" still gets its own guard, not the run-start one', async () => {
    const tenantId = randomUUID()
    await insertStepIdCollisionDefinition(admin, tenantId)
    const shop = await startShop()
    try {
      await shop.spawnWorker()

      const placed = await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() })

      const appeared = await waitUntil(() => findRunId(tenantId, placed.orderId).then((id) => id !== null), 60_000)
      expect(appeared, 'run row never appeared').toBe(true)
      const runId = await findRunId(tenantId, placed.orderId)
      if (runId === null) throw new Error('run row disappeared')

      const finished = await waitUntil(async () => (await runRow(runId))?.finished_at != null, 60_000)
      expect(finished, 'run never finished').toBe(true)

      const rows = await stepLogRows(runId)
      expect(rows.map((row) => row.step_id)).toEqual(['start', 'finish'])

      const notified = await waitUntil(async () => (await notifyLogRows(placed.orderId)).length > 0, 60_000)
      expect(notified, 'notify-staff log row never appeared for a step named "start"').toBe(true)
    } finally {
      await shop.stopAll()
    }
  }, 180_000)
})
