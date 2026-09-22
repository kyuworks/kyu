// Small polling and fixture helpers shared by the scenarios. Not a scenario
// itself; extends what src/__tests__/restart.integration.test.ts already does
// (its own waitUntil) rather than adding a second copy of the SDK's polling idiom.
import { randomUUID } from 'node:crypto'
import type { Kyu } from '@kyuworks/sdk'
import { Client } from 'pg'
import type { Pool } from 'pg'
import { z } from 'zod'
import { readConfig } from '../../config.js'
import type { PlacedOrder } from '../../producer/placeOrder.js'
import { placeOrder } from '../../producer/placeOrder.js'
import { assertNoLostEffect } from './assertions.js'
import type { EnvelopeRunOutcomes, ExpectedEffects } from './assertions.js'
import { readEffectCounts } from './reads.js'
import type { EffectWindow } from './reads.js'

export async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Places `count` orders for a fresh random tenant, sequentially so publish order is known. */
export async function placeOrders(pool: Pool, kyu: Kyu, tenantId: string, count: number): Promise<PlacedOrder[]> {
  const placed: PlacedOrder[] = []
  for (let i = 0; i < count; i += 1) {
    placed.push(await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() }))
  }
  return placed
}

export function newTenantId(): string {
  return randomUUID()
}

export interface WatchShippingRow {
  handler: string
  note: string | null
  pid: number | null
}

const watchShippingRowSchema = z.object({
  handler: z.string(),
  note: z.string().nullable(),
  pid: z.number().int().nullable(),
})

// Mirrors restart.integration.test.ts's watchLogRows: the durable handler's
// own rows for one envelope, in write order.
export async function readWatchShippingRows(pool: Pool, envelopeId: string): Promise<readonly WatchShippingRow[]> {
  const result = await pool.query(
    "SELECT handler, note, pid FROM shop_handler_log WHERE envelope_id = $1 AND handler LIKE 'watch-shipping:%' ORDER BY seq",
    [envelopeId],
  )
  return result.rows.map((row) => watchShippingRowSchema.parse(row))
}

// An outbox row settling (published_at set) only means the relay pushed it;
// the worker still has to pick it up and run the handler. Scenarios wait on
// this before reading final counts, so a slow (not lost) handler run does
// not read as a false no-effect-lost failure.
export async function waitForExpectedEffects(
  pool: Pool,
  window: EffectWindow,
  expectations: readonly ExpectedEffects[],
  timeoutMs: number,
): Promise<boolean> {
  return waitUntil(
    async () => {
      const counts = await readEffectCounts(pool, window)
      return expectations.every((expected) => assertNoLostEffect(counts, expected).length === 0)
    },
    timeoutMs,
    500,
  )
}

// One call per envelope, `limit` in flight at once: at a few thousand
// envelopes (the load scenario) an unbounded Promise.all opens that many
// concurrent engine reads at once. A worker pool of `limit` bounds it
// instead of trading concurrency for a hand-rolled batching loop.
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from<R>({ length: items.length })
  let nextIndex = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      const item = items[index]
      if (item === undefined) return
      results[index] = await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const RUN_OUTCOME_CONCURRENCY = 20

// The only way to see a doubled handler that `shop_handler_log_once_idx`
// turned into a failed run instead of a second row (assertions.ts's
// assertNoFailedRun): read the engine's own run outcomes, one call per
// envelope, `RUN_OUTCOME_CONCURRENCY` at a time. At load-scenario volumes
// (thousands of envelopes) even this many round trips is slow; the load
// scenario samples its envelope ids before calling this rather than reading
// every one (see scenarios/tenantLoad.ts and the written report).
export async function readEnvelopeRunOutcomes(
  kyu: Kyu,
  envelopeIds: readonly string[],
): Promise<readonly EnvelopeRunOutcomes[]> {
  return mapWithConcurrency(envelopeIds, RUN_OUTCOME_CONCURRENCY, async (envelopeId) => ({
    envelopeId,
    outcomes: await kyu.runs.forEnvelope(envelopeId),
  }))
}

/** A direct pg connection for fixtures that need one (`Client`, not `Pool`): workflow fixtures under src/__tests__/. */
export async function openAdminClient(): Promise<Client> {
  const config = readConfig()
  const client = new Client({ connectionString: config.databaseUrl })
  await client.connect()
  return client
}

export interface WorkflowRunStateRow {
  runId: string
  versionId: string
  finishedAt: Date | null
}

const workflowRunStateRowSchema = z.object({
  run_id: z.uuid(),
  version_id: z.uuid(),
  finished_at: z.date().nullable(),
})

/** The one `shop_workflow_run` row for this order, if `placeOrder` triggered one. */
export async function findWorkflowRun(
  pool: Pool,
  tenantId: string,
  orderId: string,
): Promise<WorkflowRunStateRow | null> {
  const result = await pool.query(
    'SELECT run_id, version_id, finished_at FROM shop_workflow_run WHERE tenant_id = $1 AND order_id = $2',
    [tenantId, orderId],
  )
  const row = result.rows[0]
  if (row === undefined) return null
  const parsed = workflowRunStateRowSchema.parse(row)
  return { runId: parsed.run_id, versionId: parsed.version_id, finishedAt: parsed.finished_at }
}

export interface WorkflowStepLogRow {
  stepId: string
  kind: string
  exitStepId: string | null
  tenantId: string
}

const workflowStepLogRowSchema = z.object({
  step_id: z.string(),
  kind: z.string(),
  exit_step_id: z.string().nullable(),
  tenant_id: z.uuid(),
})

/** This run's step ledger, in write order — mirrors restart.integration.test.ts's own stepLogRows. */
export async function readWorkflowStepLog(pool: Pool, runId: string): Promise<readonly WorkflowStepLogRow[]> {
  const result = await pool.query(
    'SELECT step_id, kind, exit_step_id, tenant_id FROM shop_workflow_step_log WHERE run_id = $1 ORDER BY at',
    [runId],
  )
  return result.rows.map((row) => {
    const parsed = workflowStepLogRowSchema.parse(row)
    return { stepId: parsed.step_id, kind: parsed.kind, exitStepId: parsed.exit_step_id, tenantId: parsed.tenant_id }
  })
}

export interface WorkflowContinuationRow {
  id: string
  publishAt: Date
  publishedAt: Date | null
  resumeStepId: string | null
}

const workflowContinuationRowSchema = z.object({
  id: z.uuid(),
  publish_at: z.date(),
  published_at: z.date().nullable(),
  resume_step_id: z.string().nullable(),
})

/** The scheduled continuation a long delay hands off to (#113) — the row its own `hold` step published, not the trigger. */
export async function readWorkflowContinuations(
  pool: Pool,
  triggerEnvelopeId: string,
  runId: string,
): Promise<readonly WorkflowContinuationRow[]> {
  const result = await pool.query(
    `SELECT id, publish_at, published_at, envelope->'data'->>'resumeStepId' AS resume_step_id
     FROM kyu_outbox
     WHERE name = 'shop.workflow.triggered' AND id <> $1 AND envelope->>'correlationId' = $2`,
    [triggerEnvelopeId, runId],
  )
  return result.rows.map((row) => {
    const parsed = workflowContinuationRowSchema.parse(row)
    return {
      id: parsed.id,
      publishAt: parsed.publish_at,
      publishedAt: parsed.published_at,
      resumeStepId: parsed.resume_step_id,
    }
  })
}

const notifyCountRowSchema = z.object({ count: z.coerce.number().int() })

/** Whether a workflow run's notify step ever published `shop.staff.notify` — cancel-between-steps expects zero. */
export async function countNotifyOutboxForRun(pool: Pool, runId: string): Promise<number> {
  const result = await pool.query(
    "SELECT count(*)::int AS count FROM kyu_outbox WHERE name = 'shop.staff.notify' AND envelope->'data'->>'runId' = $1",
    [runId],
  )
  return notifyCountRowSchema.parse(result.rows[0]).count
}
