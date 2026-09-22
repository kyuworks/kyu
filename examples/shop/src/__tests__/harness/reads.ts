// The harness's own trust edge for the tables it reads: every query here
// parses its rows with zod once; assertions.ts takes only already-parsed values.
import type { QueryParam, QueryRows } from '@kyuworks/sdk'
import { z } from 'zod'
import type {
  EffectCounts,
  HandlerEffectRow,
  NotifyOutboxRow,
  OrderingRow,
  OutboxStateRow,
  TenantRow,
  WorkflowRunRow,
} from './assertions.js'

// A pool, a pool client and a plain client all satisfy this (mirrors
// examples/shop/src/ui/busCounts.ts's CountsSource).
export interface HarnessDb {
  query(text: string, params: readonly QueryParam[]): Promise<QueryRows>
}

// Postgres array literal for `= ANY($n::uuid[])`; readonly string[] is not a
// driver-native param (mirrors packages/sdk/src/outbox/outboxRepository.ts).
function uuidArrayLiteral(ids: readonly string[]): string {
  return `{${ids.map((id) => JSON.stringify(id)).join(',')}}`
}

export interface EffectWindow {
  tenantIds: readonly string[]
}

const handlerEffectRowSchema = z.object({
  handler: z.string(),
  envelope_id: z.uuid(),
  count: z.coerce.number().int(),
})

const workflowRunRowSchema = z.object({
  tenant_id: z.uuid(),
  order_id: z.uuid(),
  count: z.coerce.number().int(),
})

const notifyOutboxRowSchema = z.object({
  run_id: z.uuid().nullable(),
  step_id: z.string().nullable(),
  count: z.coerce.number().int(),
})

async function readHandlerEffectCounts(db: HarnessDb, window: EffectWindow): Promise<readonly HandlerEffectRow[]> {
  const result = await db.query(
    'SELECT handler, envelope_id, count(*)::int AS count FROM shop_handler_log WHERE tenant_id = ANY($1::uuid[]) GROUP BY 1, 2',
    [uuidArrayLiteral(window.tenantIds)],
  )
  return result.rows.map((row) => {
    const parsed = handlerEffectRowSchema.parse(row)
    return { handler: parsed.handler, envelopeId: parsed.envelope_id, count: parsed.count }
  })
}

async function readWorkflowRunCounts(db: HarnessDb, window: EffectWindow): Promise<readonly WorkflowRunRow[]> {
  const result = await db.query(
    'SELECT tenant_id, order_id, count(*)::int AS count FROM shop_workflow_run WHERE tenant_id = ANY($1::uuid[]) GROUP BY 1, 2',
    [uuidArrayLiteral(window.tenantIds)],
  )
  return result.rows.map((row) => {
    const parsed = workflowRunRowSchema.parse(row)
    return { tenantId: parsed.tenant_id, orderId: parsed.order_id, count: parsed.count }
  })
}

async function readNotifyDuplicates(db: HarnessDb): Promise<readonly NotifyOutboxRow[]> {
  const result = await db.query(
    `SELECT envelope->'data'->>'runId' AS run_id, envelope->'data'->>'stepId' AS step_id, count(*)::int AS count
     FROM kyu_outbox WHERE name = 'shop.staff.notify' GROUP BY 1, 2`,
    [],
  )
  const rows: NotifyOutboxRow[] = []
  for (const raw of result.rows) {
    const parsed = notifyOutboxRowSchema.parse(raw)
    if (parsed.run_id === null || parsed.step_id === null) continue
    rows.push({ runId: parsed.run_id, stepId: parsed.step_id, count: parsed.count })
  }
  return rows
}

/** The one place that opens all three counters for a no-lost/no-doubled check; interior functions take the result. */
export async function readEffectCounts(db: HarnessDb, window: EffectWindow): Promise<EffectCounts> {
  const [handlerRows, workflowRunRows, notifyOutboxRows] = await Promise.all([
    readHandlerEffectCounts(db, window),
    readWorkflowRunCounts(db, window),
    readNotifyDuplicates(db),
  ])
  return { handlerRows, workflowRunRows, notifyOutboxRows }
}

const outboxStateRowSchema = z.object({
  id: z.uuid(),
  published_at: z.date().nullable(),
  dead_at: z.date().nullable(),
})

export async function readOutboxState(db: HarnessDb): Promise<readonly OutboxStateRow[]> {
  const result = await db.query('SELECT id, published_at, dead_at FROM kyu_outbox', [])
  return result.rows.map((row) => outboxStateRowSchema.parse(row))
}

export interface OutboxLag {
  pending: number
  oldestSeconds: number
}

const outboxLagRowSchema = z.object({ pending: z.coerce.number().int(), oldest_seconds: z.coerce.number().nullable() })

/** The backlog scenario's sample: how many rows are still waiting, and how old the oldest one is. */
export async function readOutboxLag(db: HarnessDb): Promise<OutboxLag> {
  const result = await db.query(
    `SELECT count(*)::int AS pending, extract(epoch from (now() - min(created_at)))::float AS oldest_seconds
     FROM kyu_outbox WHERE published_at IS NULL AND dead_at IS NULL`,
    [],
  )
  const parsed = outboxLagRowSchema.parse(result.rows[0])
  return { pending: parsed.pending, oldestSeconds: parsed.oldest_seconds ?? 0 }
}

const tenantRowSchema = z.object({ tenant_id: z.uuid() })

export interface TenantWindow {
  envelopeIds: readonly string[]
  publishingTenantId: string
}

export async function readTenantIds(db: HarnessDb, window: TenantWindow): Promise<readonly TenantRow[]> {
  const result = await db.query('SELECT DISTINCT tenant_id FROM shop_handler_log WHERE envelope_id = ANY($1::uuid[])', [
    uuidArrayLiteral(window.envelopeIds),
  ])
  return result.rows.map((row) => {
    const parsed = tenantRowSchema.parse(row)
    return { tenantId: parsed.tenant_id, publishingTenantId: window.publishingTenantId }
  })
}

const orderingRowSchema = z.object({
  order_id: z.uuid().nullable(),
  handler: z.string(),
  seq: z.coerce.number().int(),
})

// Reads in arrival order (`at`, the wall-clock write time), not by `seq`
// (the bigserial insertion sequence) — `assertPerKeyOrdering` checks that
// `seq` still comes back monotonic per key in that order. Ordering by `seq`
// itself would make that check vacuous: any subsequence of an already
// seq-sorted result is trivially seq-sorted too.
export async function readOrdering(db: HarnessDb, orderIds: readonly string[]): Promise<readonly OrderingRow[]> {
  const result = await db.query(
    'SELECT order_id, handler, seq FROM shop_handler_log WHERE order_id = ANY($1::uuid[]) ORDER BY at, seq',
    [uuidArrayLiteral(orderIds)],
  )
  const rows: OrderingRow[] = []
  for (const raw of result.rows) {
    const parsed = orderingRowSchema.parse(raw)
    if (parsed.order_id === null) continue
    rows.push({ orderId: parsed.order_id, handler: parsed.handler, seq: parsed.seq })
  }
  return rows
}
