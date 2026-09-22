// Pure checks over already-parsed rows. reads.ts decodes pg rows with zod
// once, at the edge; nothing here re-parses a value a caller already parsed.
import type { RunOutcome } from '@kyuworks/sdk'

export interface HandlerEffectRow {
  handler: string
  envelopeId: string
  count: number
}

export interface WorkflowRunRow {
  tenantId: string
  orderId: string
  count: number
}

export interface NotifyOutboxRow {
  runId: string
  stepId: string
  count: number
}

export interface EffectCounts {
  handlerRows: readonly HandlerEffectRow[]
  workflowRunRows: readonly WorkflowRunRow[]
  notifyOutboxRows: readonly NotifyOutboxRow[]
}

export interface ExpectedEffects {
  envelopeIds: readonly string[]
  handlers: readonly string[]
}

export interface OutboxStateRow {
  id: string
  published_at: Date | null
  dead_at: Date | null
}

export interface TenantRow {
  tenantId: string
  publishingTenantId: string
}

export interface OrderingRow {
  orderId: string
  handler: string
  seq: number
}

export interface AssertionFailure {
  check: string
  detail: string
}

/**
 * No handler ran twice for one envelope, no workflow run doubled for one order, no notify published twice for one step.
 * In these crash scenarios a genuine double rarely shows up here: `shop_handler_log_once_idx` turns a second
 * `onceById` write into a failed run instead of a second row, and the workflow tables stay empty (a fresh random
 * tenant has no enabled workflow definition). `assertNoFailedRun` reads the engine's own run outcomes and catches it there.
 */
export function assertNoDoubleEffect(counts: EffectCounts): readonly AssertionFailure[] {
  const failures: AssertionFailure[] = []
  for (const row of counts.handlerRows) {
    if (row.count > 1) {
      failures.push({
        check: 'no-effect-doubled',
        detail: `handler "${row.handler}" ran ${String(row.count)} times for envelope ${row.envelopeId}`,
      })
    }
  }
  for (const row of counts.workflowRunRows) {
    if (row.count > 1) {
      failures.push({
        check: 'no-effect-doubled',
        detail: `${String(row.count)} shop_workflow_run rows for tenant ${row.tenantId} order ${row.orderId}`,
      })
    }
  }
  for (const row of counts.notifyOutboxRows) {
    if (row.count > 1) {
      failures.push({
        check: 'no-effect-doubled',
        detail: `shop.staff.notify published ${String(row.count)} times for run ${row.runId} step ${row.stepId}`,
      })
    }
  }
  return failures
}

/** Every envelope the scenario published has every expected handler row. */
export function assertNoLostEffect(counts: EffectCounts, expected: ExpectedEffects): readonly AssertionFailure[] {
  const failures: AssertionFailure[] = []
  const seen = new Set(counts.handlerRows.map((row) => `${row.handler}:${row.envelopeId}`))
  for (const envelopeId of expected.envelopeIds) {
    for (const handler of expected.handlers) {
      if (!seen.has(`${handler}:${envelopeId}`)) {
        failures.push({
          check: 'no-effect-lost',
          detail: `handler "${handler}" never ran for envelope ${envelopeId}`,
        })
      }
    }
  }
  return failures
}

/** No outbox row left pending and none retired: the backlog this scenario made must fully drain. */
export function assertOutboxSettled(rows: readonly OutboxStateRow[]): readonly AssertionFailure[] {
  const failures: AssertionFailure[] = []
  for (const row of rows) {
    if (row.published_at === null && row.dead_at === null) {
      failures.push({ check: 'outbox-settled', detail: `outbox row ${row.id} is still pending` })
    }
    if (row.dead_at !== null) {
      failures.push({ check: 'outbox-settled', detail: `outbox row ${row.id} was retired` })
    }
  }
  return failures
}

/** Every row's tenant id equals the tenant id it was published under. */
export function assertTenantUnchanged(rows: readonly TenantRow[]): readonly AssertionFailure[] {
  const failures: AssertionFailure[] = []
  for (const row of rows) {
    if (row.tenantId !== row.publishingTenantId) {
      failures.push({
        check: 'tenant-id-unchanged',
        detail: `handler saw tenant ${row.tenantId}, expected ${row.publishingTenantId}`,
      })
    }
  }
  return failures
}

export interface EnvelopeRunOutcomes {
  envelopeId: string
  outcomes: readonly RunOutcome[]
}

/**
 * The check that actually catches a leaked double in these scenarios:
 * `shop_handler_log_once_idx` rejects a doubled `onceById` write, so the
 * second delivery's run fails on the engine side instead of leaving a second
 * row for `assertNoDoubleEffect` to see.
 */
export function assertNoFailedRun(rows: readonly EnvelopeRunOutcomes[]): readonly AssertionFailure[] {
  const failures: AssertionFailure[] = []
  for (const row of rows) {
    for (const outcome of row.outcomes) {
      if (outcome.status === 'failed') {
        failures.push({
          check: 'no-effect-doubled',
          detail: `envelope ${row.envelopeId} run ${outcome.runId} (${outcome.subscription}) failed: ${outcome.error ?? 'no error message'}`,
        })
      }
    }
  }
  return failures
}

/** Per order, per handler, rows are in publish order (ascending seq for each key). */
export function assertPerKeyOrdering(rows: readonly OrderingRow[]): readonly AssertionFailure[] {
  const failures: AssertionFailure[] = []
  const lastSeqByKey = new Map<string, number>()
  for (const row of rows) {
    const key = `${row.orderId}:${row.handler}`
    const lastSeq = lastSeqByKey.get(key)
    if (lastSeq !== undefined && row.seq < lastSeq) {
      failures.push({
        check: 'per-key-ordering',
        detail: `order ${row.orderId} handler "${row.handler}" saw seq ${String(row.seq)} after ${String(lastSeq)}`,
      })
    }
    lastSeqByKey.set(key, row.seq)
  }
  return failures
}
