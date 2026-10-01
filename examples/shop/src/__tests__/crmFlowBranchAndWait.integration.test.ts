import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Kyu } from '@kyuworks/sdk'
import { Client } from 'pg'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ShopConfig } from '../config.js'
import { readConfig } from '../config.js'
import { createPool, withTransaction } from '../db/pool.js'
import { RUN_WORKFLOW_NAME } from '../handlers/runWorkflow.js'
import { createShopKyu } from '../kyu.js'
import { workflowTriggered } from '../messages.js'
import { placeOrder } from '../producer/placeOrder.js'
import { triggerWorkflowOn } from '../producer/triggerWorkflow.js'
import { insertCrmBranchDefinition, insertCrmDurationDefinition, insertLeadProjection } from './workflowFixtures.js'
import { spawnProcess, stopAllSpawnedProcesses } from './processes.js'
import type { SpawnedProcess } from './processes.js'

// Two shop-authored fixtures in the CRM node shape (issue #157 PR B): a `branch` node
// and a `duration` wait. Neither appears in the order follow-up flow that
// crmFlow.integration.test.ts covers. Same shape as workflowLongDelay.integration.test.ts throughout.
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
  outcome: string | null
}

async function runRow(runId: string): Promise<RunRow | null> {
  const result = await admin.query<RunRow>(
    'SELECT version_id, tenant_id, finished_at, outcome FROM shop_workflow_run WHERE run_id = $1',
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

async function startShop(): Promise<Shop> {
  const namespace = `cbw_${randomBytes(4).toString('hex')}_`
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

describe('run-workflow: a CRM flow branch node', () => {
  it('decides the branch once and reuses the recorded exit when the trigger is redelivered', async () => {
    const tenantId = randomUUID()
    const customerId = randomUUID()
    const shop = await startShop()
    const scopedKyu = createShopKyu({ ...baseConfig, namespace: shop.namespace })
    try {
      const workerA = await shop.spawnWorker()

      // placeOrder before the definition is enabled: it triggers no run of
      // its own, but the order row must exist before shop_lead_projection's
      // FK can be seeded.
      const placed = await placeOrder(pool, kyu, { tenantId, customerId })
      const definition = await insertCrmBranchDefinition(admin, tenantId)
      await insertLeadProjection(admin, { tenantId, orderId: placed.orderId, scoreBand: 'warm' })

      const triggered = await withTransaction(pool, (client) =>
        triggerWorkflowOn(client, kyu, { tenantId, orderId: placed.orderId }),
      )
      if (triggered === null) throw new Error('no definition was enabled for the trigger')
      const { runId, versionId } = triggered

      const finished = await waitUntil(async () => (await runRow(runId))?.finished_at != null, 60_000)
      expect(finished, 'run never finished').toBe(true)

      const firstRows = await stepLogRows(runId)
      expect(firstRows.map((row) => row.step_id)).toEqual(['checkBand', 'thankYou', 'endThanked'])
      const checkBandRow = firstRows.find((row) => row.step_id === 'checkBand')
      expect(checkBandRow?.kind).toBe('branch')
      expect(checkBandRow?.exit_step_id).toBe('thankYou')
      const endThankedRow = firstRows.find((row) => row.step_id === 'endThanked')
      expect(endThankedRow?.exit_step_id).toBeNull()
      for (const row of firstRows) expect(row.tenant_id).toBe(tenantId)

      const firstRun = await runRow(runId)
      expect(firstRun?.outcome).toBe('thanked')

      const notifiedOnce = await waitUntil(async () => (await notifyLogRows(placed.orderId)).length >= 1, 60_000)
      expect(notifiedOnce, 'notify-staff log row never appeared').toBe(true)
      let notifyRows = await notifyLogRows(placed.orderId)
      expect(notifyRows).toHaveLength(1)
      expect(notifyRows[0]?.note).toBe('notify thankYou')

      // A cold lead would take otherwise to endSkipped — if the branch were
      // re-decided instead of reusing its recorded exit.
      await admin.query(
        "UPDATE shop_lead_projection SET projection = jsonb_set(projection, '{scoreBand}', '\"cold\"') WHERE tenant_id = $1 AND order_id = $2",
        [tenantId, placed.orderId],
      )

      await workerA.stop()
      await shop.spawnWorker()

      const redeliveryEnvelope = await withTransaction(pool, (tx) =>
        kyu.publish(
          tx,
          workflowTriggered,
          { runId, definitionId: definition.definitionId, versionId, orderId: placed.orderId },
          { tenantId, correlationId: runId },
        ),
      )

      const redeliveryCompleted = await waitUntil(async () => {
        const outcomes = await scopedKyu.runs.forEnvelope(redeliveryEnvelope.id)
        return outcomes.some((outcome) => outcome.subscription === RUN_WORKFLOW_NAME && outcome.status === 'completed')
      }, 60_000)
      expect(redeliveryCompleted, 'the redelivered trigger never read completed').toBe(true)

      // Nothing moved: the branch reused its recorded exit instead of
      // re-deciding against the now-cold projection (must-hold: redelivery
      // of the same envelope id is idempotent).
      const settledRows = await stepLogRows(runId)
      expect(settledRows.map((row) => row.step_id)).toEqual(['checkBand', 'thankYou', 'endThanked'])
      expect(settledRows.find((row) => row.step_id === 'checkBand')?.exit_step_id).toBe('thankYou')
      notifyRows = await notifyLogRows(placed.orderId)
      expect(notifyRows).toHaveLength(1)
      const settledRun = await runRow(runId)
      expect(settledRun?.outcome).toBe('thanked')
    } finally {
      await shop.stopAll()
    }
  }, 240_000)
})

describe('run-workflow: a CRM flow duration wait', () => {
  it('hands the one-minute wait off and finishes on a worker started after the first one stopped', async () => {
    const tenantId = randomUUID()
    const shop = await startShop()
    const scopedKyu = createShopKyu({ ...baseConfig, namespace: shop.namespace })
    try {
      const workerA = await shop.spawnWorker()

      const definition = await insertCrmDurationDefinition(admin, tenantId)
      const placed = await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() })
      const triggerEnvelopeId = placed.envelopeIds.workflowTriggered
      if (triggerEnvelopeId === undefined) throw new Error('placeOrder did not trigger a workflow run')

      const appeared = await waitUntil(() => findRunId(tenantId, placed.orderId).then((id) => id !== null), 60_000)
      expect(appeared, 'run row never appeared').toBe(true)
      const runId = await findRunId(tenantId, placed.orderId)
      if (runId === null) throw new Error('run row disappeared')

      const waited = await waitUntil(
        async () => (await stepLogRows(runId)).some((row) => row.step_id === 'pause_1m'),
        60_000,
      )
      expect(waited, 'pause_1m ledger row never appeared').toBe(true)
      const pauseRow = (await stepLogRows(runId)).find((row) => row.step_id === 'pause_1m')
      expect(pauseRow?.kind).toBe('wait_duration')
      expect(pauseRow?.exit_step_id).toBe('end_paused')

      const continuation = await continuationRows(triggerEnvelopeId, runId)
      expect(continuation, 'exactly one continuation row').toHaveLength(1)
      const row = continuation.at(0)
      if (row === undefined) throw new Error('unreachable')
      expect(row.published_at).toBeNull()
      const publishAtMs = row.publish_at.getTime()
      const nowMs = Date.now()
      expect(publishAtMs).toBeGreaterThan(nowMs + 40 * 1000)
      expect(publishAtMs).toBeLessThan(nowMs + 70 * 1000)
      expect(row.resume_step_id).toBe('end_paused')
      expect(row.tenant_id).toBe(tenantId)

      const outcomeCompleted = await waitUntil(async () => {
        const outcomes = await scopedKyu.runs.forEnvelope(triggerEnvelopeId)
        return outcomes.some((outcome) => outcome.subscription === RUN_WORKFLOW_NAME && outcome.status === 'completed')
      }, 60_000)
      expect(outcomeCompleted, 'the first run never read completed').toBe(true)
      const outcomes = await scopedKyu.runs.forEnvelope(triggerEnvelopeId)
      for (const outcome of outcomes.filter((candidate) => candidate.subscription === RUN_WORKFLOW_NAME)) {
        expect(outcome.status, 'the first run must not be cancelled or failed').not.toBe('cancelled')
        expect(outcome.status).not.toBe('failed')
      }

      await workerA.stop()
      await shop.spawnWorker()

      const finished = await waitUntil(async () => (await runRow(runId))?.finished_at != null, 120_000)
      expect(finished, 'run never finished').toBe(true)

      const finalRows = await stepLogRows(runId)
      expect(finalRows.map((finalRow) => finalRow.step_id)).toEqual(['pause_1m', 'end_paused'])
      for (const finalRow of finalRows) expect(finalRow.tenant_id).toBe(tenantId)
      const finishedRun = await runRow(runId)
      expect(finishedRun?.outcome).toBe('paused')
      expect(finishedRun?.version_id).toBe(definition.versionId)

      // The end_paused row was written after worker A stopped: the continuation
      // envelope's own run-workflow run reads completed, which can only
      // have happened on worker B.
      const continuationCompleted = await waitUntil(async () => {
        const continuationOutcomes = await scopedKyu.runs.forEnvelope(row.id)
        return continuationOutcomes.some(
          (outcome) => outcome.subscription === RUN_WORKFLOW_NAME && outcome.status === 'completed',
        )
      }, 30_000)
      expect(continuationCompleted, 'the continuation run never read completed').toBe(true)
    } finally {
      await shop.stopAll()
    }
  }, 240_000)
})
