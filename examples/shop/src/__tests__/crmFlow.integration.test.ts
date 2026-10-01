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
import { insertCrmFlowDefinition } from './workflowFixtures.js'
import { spawnProcess, stopAllSpawnedProcesses } from './processes.js'
import type { SpawnedProcess } from './processes.js'

// The shop-authored order follow-up flow in the CRM node shape (issue #157),
// stored and walked as written. Its wait is 120 minutes — far above the 60s hand-off threshold
// (handlers/runWorkflow.ts's DELAY_HANDOFF_SECONDS) — so the run always parks
// as a scheduled outbox row, never in sleepFor. This test forces a worker
// restart across that hand-off, the same shape as workflowLongDelay.integration.test.ts.
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
  spawnWorker(): Promise<SpawnedProcess>
  stopAll(): Promise<void>
}

async function startShop(): Promise<Shop> {
  const namespace = `cf_${randomBytes(4).toString('hex')}_`
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

describe('run-workflow: a CRM flow definition', () => {
  it('walks the order follow-up flow and finishes on a new worker after a restart', async () => {
    const tenantId = randomUUID()
    const definition = await insertCrmFlowDefinition(admin, tenantId)
    const shop = await startShop()
    try {
      const workerA = await shop.spawnWorker()

      const placed = await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() })
      const triggerEnvelopeId = placed.envelopeIds.workflowTriggered
      if (triggerEnvelopeId === undefined) throw new Error('placeOrder did not trigger a workflow run')

      const appeared = await waitUntil(() => findRunId(tenantId, placed.orderId).then((id) => id !== null), 60_000)
      expect(appeared, 'run row never appeared').toBe(true)
      const runId = await findRunId(tenantId, placed.orderId)
      if (runId === null) throw new Error('run row disappeared')

      const call1Seen = await waitUntil(
        async () => (await stepLogRows(runId)).some((row) => row.step_id === 'call1'),
        60_000,
      )
      expect(call1Seen, 'call1 ledger row never appeared').toBe(true)
      const call1Row = (await stepLogRows(runId)).find((row) => row.step_id === 'call1')
      expect(call1Row?.kind).toBe('create_task')
      expect(call1Row?.exit_step_id).toBe('waitCall')

      const waitCallSeen = await waitUntil(
        async () => (await stepLogRows(runId)).some((row) => row.step_id === 'waitCall'),
        60_000,
      )
      expect(waitCallSeen, 'waitCall ledger row never appeared').toBe(true)
      const waitCallRow = (await stepLogRows(runId)).find((row) => row.step_id === 'waitCall')
      expect(waitCallRow?.kind).toBe('wait_for_completion')
      expect(waitCallRow?.exit_step_id).toBe('release1')

      const continuation = await continuationRows(triggerEnvelopeId, runId)
      expect(continuation, 'exactly one continuation row').toHaveLength(1)
      const row = continuation.at(0)
      if (row === undefined) throw new Error('unreachable')
      expect(row.published_at).toBeNull()
      const publishAtMs = row.publish_at.getTime()
      const nowMs = Date.now()
      expect(publishAtMs).toBeGreaterThan(nowMs + 119 * 60 * 1000)
      expect(publishAtMs).toBeLessThan(nowMs + 121 * 60 * 1000)
      expect(row.resume_step_id).toBe('release1')
      expect(row.tenant_id).toBe(tenantId)

      await workerA.stop()
      const workerB = await shop.spawnWorker()
      const workerBPid = workerB.child.pid

      await admin.query('UPDATE kyu_outbox SET publish_at = now() WHERE id = $1', [row.id])

      const finished = await waitUntil(async () => (await runRow(runId))?.finished_at != null, 90_000)
      expect(finished, 'run never finished').toBe(true)

      const finalRows = await stepLogRows(runId)
      expect(finalRows.map((finalRow) => finalRow.step_id)).toEqual([
        'call1',
        'waitCall',
        'release1',
        'reassign1',
        'tellOwner',
        'endReassigned',
      ])
      for (const finalRow of finalRows) expect(finalRow.tenant_id).toBe(tenantId)
      const reassign1Row = finalRows.find((finalRow) => finalRow.step_id === 'reassign1')
      expect(reassign1Row?.exit_step_id).toBe('tellOwner')
      const endReassignedRow = finalRows.find((finalRow) => finalRow.step_id === 'endReassigned')
      expect(endReassignedRow?.exit_step_id).toBeNull()

      const finishedRun = await runRow(runId)
      expect(finishedRun?.outcome).toBe('reassigned')
      expect(finishedRun?.version_id).toBe(definition.versionId)

      const notified = await waitUntil(async () => (await notifyLogRows(placed.orderId)).length >= 4, 60_000)
      expect(notified, 'notify-staff log rows never appeared').toBe(true)
      const notifyRows = await notifyLogRows(placed.orderId)
      expect(notifyRows).toHaveLength(4)
      expect(notifyRows.map((notifyRow) => notifyRow.note)).toEqual([
        'create_task call1',
        'unassign_lead release1',
        'assign_lead reassign1',
        'notify tellOwner',
      ])
      for (const notifyRow of notifyRows) expect(notifyRow.tenant_id).toBe(tenantId)
      // call1 is logged before the restart (worker A); release1/reassign1/tellOwner after (worker B).
      expect(notifyRows.at(-1)?.pid).toBe(workerBPid)
    } finally {
      await shop.stopAll()
    }
  }, 240_000)
})

describe('run-workflow: redelivery of the trigger that parked a wait node', () => {
  // Must-hold: redelivery of the same envelope id is idempotent. waitCall's
  // hand-off records its exit (release1) so the scheduled continuation can find it
  // later; a second delivery of the ORIGINAL trigger must not read that same
  // record as "already decided, keep walking" — it must park again.
  it('does not walk past a parked wait node when the original trigger is redelivered', async () => {
    const tenantId = randomUUID()
    await insertCrmFlowDefinition(admin, tenantId)
    const shop = await startShop()
    try {
      await shop.spawnWorker()

      const placed = await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() })
      const triggerEnvelopeId = placed.envelopeIds.workflowTriggered
      if (triggerEnvelopeId === undefined) throw new Error('placeOrder did not trigger a workflow run')

      const appeared = await waitUntil(() => findRunId(tenantId, placed.orderId).then((id) => id !== null), 60_000)
      expect(appeared, 'run row never appeared').toBe(true)
      const runId = await findRunId(tenantId, placed.orderId)
      if (runId === null) throw new Error('run row disappeared')

      const waitCallParked = await waitUntil(
        async () => (await stepLogRows(runId)).some((row) => row.step_id === 'waitCall'),
        60_000,
      )
      expect(waitCallParked, 'waitCall ledger row never appeared').toBe(true)

      const continuation = await continuationRows(triggerEnvelopeId, runId)
      expect(continuation, 'exactly one continuation row after the hand-off').toHaveLength(1)

      // Simulate at-least-once redelivery of the ORIGINAL trigger: the relay
      // re-claims and re-pushes any outbox row with a null published_at.
      await admin.query('UPDATE kyu_outbox SET published_at = NULL WHERE id = $1', [triggerEnvelopeId])

      const wentPastWait = await waitUntil(
        async () => (await stepLogRows(runId)).some((row) => row.step_id === 'release1'),
        45_000,
      )
      expect(wentPastWait, 'redelivery walked past the parked wait node instead of parking again').toBe(false)

      const run = await runRow(runId)
      expect(run?.finished_at, 'run finished early from a redelivered trigger').toBeNull()

      const rows = await stepLogRows(runId)
      expect(rows.map((row) => row.step_id)).toEqual(['call1', 'waitCall'])
    } finally {
      await shop.stopAll()
    }
  }, 150_000)
})
