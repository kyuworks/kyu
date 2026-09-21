import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Kyu } from '@kyuworks/sdk'
import { Client } from 'pg'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ShopConfig } from '../config.js'
import { readConfig } from '../config.js'
import { createPool } from '../db/pool.js'
import { RUN_WORKFLOW_NAME } from '../handlers/runWorkflow.js'
import { createShopKyu } from '../kyu.js'
import { placeOrder } from '../producer/placeOrder.js'
import { insertLongDelayDefinition } from './workflowFixtures.js'
import { spawnProcess, stopAllSpawnedProcesses } from './processes.js'
import type { SpawnedProcess } from './processes.js'

// A delay of 60s or more hands off to a scheduled publish instead of parking
// in sleepFor (#113). This drives that path end to end: the first run ends
// holding nothing, the continuation sits in kyu_outbox with a future
// publish_at, and a second run — on a worker started after the first one
// stopped — finishes the workflow once that time arrives.
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

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
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

interface ContinuationRow {
  id: string
  publish_at: Date
  published_at: Date | null
  resume_step_id: string | null
  tenant_id: string | null
}

// The continuation: the scheduled shop.workflow.triggered row this run's own
// hold step published, not the trigger row placeOrder published (id <> $1).
async function continuationRows(triggerEnvelopeId: string, runId: string): Promise<ContinuationRow[]> {
  const result = await admin.query<ContinuationRow>(
    `SELECT id, publish_at, published_at,
            envelope->'data'->>'resumeStepId' AS resume_step_id,
            envelope->>'tenantId' AS tenant_id
     FROM kyu_outbox
     WHERE name = 'shop.workflow.triggered' AND id <> $1 AND envelope->>'correlationId' = $2`,
    [triggerEnvelopeId, runId],
  )
  return result.rows
}

interface Shop {
  namespace: string
  spawnWorker(): Promise<SpawnedProcess>
  stopAll(): Promise<void>
}

// One namespace, one relay, per test, exactly like workflow.integration.test.ts's
// own startShop; the watch timeout is fixed at '8s' for every worker it spawns.
async function startShop(): Promise<Shop> {
  const namespace = `wfld_${randomBytes(4).toString('hex')}_`
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
    namespace,
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

describe('run-workflow: a delay that outlasts the execution timeout (#113)', () => {
  it('a delay longer than 24 hours hands off and a scheduled run finishes the workflow', async () => {
    const LONG_DELAY_SECONDS = 48 * 60 * 60
    const tenantId = randomUUID()
    const definition = await insertLongDelayDefinition(admin, tenantId, LONG_DELAY_SECONDS)
    const shop = await startShop()
    const scopedKyu = createShopKyu({ ...baseConfig, namespace: shop.namespace })
    try {
      const workerA = await shop.spawnWorker()

      const placed = await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() })
      const triggerEnvelopeId = placed.envelopeIds.workflowTriggered
      if (triggerEnvelopeId === undefined) throw new Error('placeOrder did not trigger a workflow run')

      const appeared = await waitUntil(() => findRunId(tenantId, placed.orderId).then((id) => id !== null), 60_000)
      expect(appeared, 'run row never appeared').toBe(true)
      const runId = await findRunId(tenantId, placed.orderId)
      if (runId === null) throw new Error('run row disappeared')

      const held = await waitUntil(async () => (await stepLogRows(runId)).some((row) => row.step_id === 'hold'), 60_000)
      expect(held, 'hold ledger row never appeared').toBe(true)
      const holdRow = (await stepLogRows(runId)).find((row) => row.step_id === 'hold')
      expect(holdRow?.exit_step_id).toBe('nudge')
      expect(holdRow?.tenant_id).toBe(tenantId)

      const continuation = await continuationRows(triggerEnvelopeId, runId)
      expect(continuation, 'exactly one continuation row').toHaveLength(1)
      const row = continuation.at(0)
      if (row === undefined) throw new Error('unreachable')
      expect(row.published_at).toBeNull()
      const publishAtMs = row.publish_at.getTime()
      const nowMs = Date.now()
      expect(publishAtMs).toBeGreaterThan(nowMs + 47 * 60 * 60 * 1000)
      expect(publishAtMs).toBeLessThan(nowMs + 49 * 60 * 60 * 1000)
      expect(row.resume_step_id).toBe('nudge')
      expect(row.tenant_id).toBe(tenantId)

      const outcomeCompleted = await waitUntil(async () => {
        const outcomes = await scopedKyu.runs.forEnvelope(triggerEnvelopeId)
        return outcomes.some((outcome) => outcome.subscription === RUN_WORKFLOW_NAME && outcome.status === 'completed')
      }, 60_000)
      expect(outcomeCompleted, 'the first run never read completed').toBe(true)
      const outcomes = await scopedKyu.runs.forEnvelope(triggerEnvelopeId)
      const runWorkflowOutcomes = outcomes.filter((outcome) => outcome.subscription === RUN_WORKFLOW_NAME)
      for (const outcome of runWorkflowOutcomes) {
        expect(outcome.status, 'the first run must not be cancelled or failed').not.toBe('cancelled')
        expect(outcome.status).not.toBe('failed')
      }

      await sleep(5_000)
      expect((await stepLogRows(runId)).map((stepRow) => stepRow.step_id)).toEqual(['hold'])
      expect((await runRow(runId))?.finished_at).toBeNull()
      const stillUnpublished = await continuationRows(triggerEnvelopeId, runId)
      expect(stillUnpublished[0]?.published_at).toBeNull()

      await workerA.stop()
      const workerB = await shop.spawnWorker()
      const workerBPid = workerB.child.pid

      await admin.query('UPDATE kyu_outbox SET publish_at = now() WHERE id = $1', [row.id])

      const finished = await waitUntil(async () => (await runRow(runId))?.finished_at != null, 90_000)
      expect(finished, 'run never finished').toBe(true)

      const finalRows = await stepLogRows(runId)
      expect(finalRows.map((finalRow) => finalRow.step_id)).toEqual(['hold', 'nudge', 'finish'])
      for (const finalRow of finalRows) expect(finalRow.tenant_id).toBe(tenantId)
      const finishedRun = await runRow(runId)
      expect(finishedRun?.version_id).toBe(definition.versionId)

      const notified = await waitUntil(async () => (await notifyLogRows(placed.orderId)).length > 0, 60_000)
      expect(notified, 'notify-staff log row never appeared').toBe(true)
      const notifyRows = await notifyLogRows(placed.orderId)
      expect(notifyRows).toHaveLength(1)
      expect(notifyRows[0]?.tenant_id).toBe(tenantId)
      expect(notifyRows[0]?.pid).toBe(workerBPid)
    } finally {
      await shop.stopAll()
    }
  }, 240_000)
})
