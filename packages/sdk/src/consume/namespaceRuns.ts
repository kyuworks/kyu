import { KyuError, V1TaskStatus } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import { cancelUnclaimedOutboxRows } from '../outbox/outboxRepository.js'
import { parseTenantId } from '../outbox/tenantPause.js'
import { toCheckedRunOutcomes } from './runOutcomes.js'
import type { CancelRunsOptions, RunDetailReader, RunOutcome } from './runOutcomes.js'

// Narrowed to what this file needs, so the unit test's fake is a plain object.
export interface NamespaceRunsClient {
  config: Pick<HatchetClient['config'], 'namespace'>
  runs: Pick<HatchetClient['runs'], 'list' | 'cancel'> & RunDetailReader['runs']
  workflows: Pick<HatchetClient['workflows'], 'list'>
}

export interface NamespaceRunsOptions {
  /** Ignore runs created before this. Required: a namespace has no id to date itself from. */
  since: Date
}

/** With `outbox`, that tenant's outbox rows the relay has not claimed, held rows included, are cancelled in the caller's transaction after the engine cancel. */
export type CancelTenantRunsOptions = NamespaceRunsOptions & Pick<CancelRunsOptions, 'outbox'>

const UNSETTLED_STATUSES = [V1TaskStatus.QUEUED, V1TaskStatus.RUNNING]
const RUN_PAGE_LIMIT = 100
const RUN_MAX_PAGES = 200
const WORKFLOW_PAGE_LIMIT = 100
const WORKFLOW_MAX_PAGES = 10

/** The public method's name, so a thrown KyuError names what the caller called — mirrors runOutcomes.ts's RunLookup.caller. */
type UnsettledReadCaller = 'runs.unsettledInNamespace' | 'runs.unsettledForTenant'
type UnsettledCancelCaller = 'runs.cancelUnsettledInNamespace' | 'runs.cancelForTenant'
type NamespaceRunsCaller = UnsettledReadCaller | UnsettledCancelCaller

// The engine's own workflow listing defaults to 50 rows, and its `name` is a
// substring search: page it, then keep only exact namespace prefixes.
async function namespaceWorkflowNames(
  hatchet: NamespaceRunsClient,
  namespace: string,
  caller: NamespaceRunsCaller,
): Promise<readonly string[]> {
  const names: string[] = []
  for (let page = 0; page < WORKFLOW_MAX_PAGES; page += 1) {
    const list = await hatchet.workflows.list({
      name: namespace,
      limit: WORKFLOW_PAGE_LIMIT,
      offset: page * WORKFLOW_PAGE_LIMIT,
    })
    const rows = list.rows ?? []
    for (const row of rows) if (row.name.startsWith(namespace)) names.push(row.name)
    if (rows.length < WORKFLOW_PAGE_LIMIT) return names
  }
  throw new KyuError(
    `${caller}: namespace "${namespace}" holds more than ${String(WORKFLOW_MAX_PAGES * WORKFLOW_PAGE_LIMIT)} workflows`,
  )
}

// The relay copies the envelope's tenantId to the `tenantId` run metadata key; the engine applies it with the workflow filter.
function unsettledRunFilter(workflowNames: readonly string[], since: Date, tenantId: string | undefined) {
  const additionalMetadata: Record<string, string> = {}
  if (tenantId !== undefined) additionalMetadata['tenantId'] = tenantId
  return { workflowNames: [...workflowNames], statuses: UNSETTLED_STATUSES, since, additionalMetadata }
}

async function readUnsettledRuns(
  hatchet: NamespaceRunsClient,
  options: NamespaceRunsOptions,
  caller: UnsettledReadCaller,
  tenantId?: string,
): Promise<readonly RunOutcome[]> {
  const namespace = hatchet.config.namespace ?? ''
  if (namespace === '') return []
  const workflowNames = await namespaceWorkflowNames(hatchet, namespace, caller)
  if (workflowNames.length === 0) return []

  const rows: Awaited<ReturnType<NamespaceRunsClient['runs']['list']>>['rows'] = []
  for (let page = 0; page < RUN_MAX_PAGES; page += 1) {
    const result = await hatchet.runs.list({
      ...unsettledRunFilter(workflowNames, options.since, tenantId),
      limit: RUN_PAGE_LIMIT,
      offset: page * RUN_PAGE_LIMIT,
      includePayloads: false,
    })
    rows.push(...result.rows)
    if (page + 1 >= (result.pagination.num_pages ?? 1)) {
      const outcomes = await toCheckedRunOutcomes(hatchet, rows, namespace, caller)
      return outcomes.filter((outcome) => outcome.status === 'queued' || outcome.status === 'running')
    }
  }
  throw new KyuError(
    `${caller}: more than ${String(RUN_MAX_PAGES * RUN_PAGE_LIMIT)} runs; narrow the window with options.since`,
  )
}

/** Every run in this client's own namespace that the engine still holds queued or running, newest first. */
export function readUnsettledRunsInNamespace(
  hatchet: NamespaceRunsClient,
  options: NamespaceRunsOptions,
): Promise<readonly RunOutcome[]> {
  return readUnsettledRuns(hatchet, options, 'runs.unsettledInNamespace')
}

/** The same, narrowed to one business tenant by the engine's own run metadata. */
export async function readUnsettledRunsForTenant(
  hatchet: NamespaceRunsClient,
  tenantId: string,
  options: NamespaceRunsOptions,
): Promise<readonly RunOutcome[]> {
  return readUnsettledRuns(
    hatchet,
    options,
    'runs.unsettledForTenant',
    parseTenantId('runs.unsettledForTenant', tenantId),
  )
}

async function cancelUnsettledRuns(
  hatchet: NamespaceRunsClient,
  options: NamespaceRunsOptions,
  caller: UnsettledCancelCaller,
  tenantId?: string,
): Promise<number> {
  const namespace = hatchet.config.namespace ?? ''
  if (namespace === '') return 0
  const workflowNames = await namespaceWorkflowNames(hatchet, namespace, caller)
  if (workflowNames.length === 0) return 0

  try {
    const response = await hatchet.runs.cancel({
      filters: unsettledRunFilter(workflowNames, options.since, tenantId),
    })
    return (response.data.ids ?? []).length
  } catch (cause) {
    throw new KyuError(`${caller}: could not cancel runs in namespace "${namespace}"`, {
      cause: cause instanceof Error ? cause : new Error(String(cause)),
    })
  }
}

/**
 * Cancels every run this client's own namespace still holds queued or
 * running, and returns how many the engine reported cancelled. An engine
 * cancel filtered by an empty workflow list is not scoped to a namespace at
 * all, so a namespace with no registered workflow sends no cancel.
 */
export function cancelUnsettledRunsInNamespace(
  hatchet: NamespaceRunsClient,
  options: NamespaceRunsOptions,
): Promise<number> {
  return cancelUnsettledRuns(hatchet, options, 'runs.cancelUnsettledInNamespace')
}

/** Cancels one business tenant's queued or running runs in this namespace and returns how many the engine cancelled; with options.outbox, then that tenant's rows the relay has not claimed. */
export async function cancelUnsettledRunsForTenant(
  hatchet: NamespaceRunsClient,
  tenantId: string,
  options: CancelTenantRunsOptions,
): Promise<number> {
  const id = parseTenantId('runs.cancelForTenant', tenantId)
  const cancelled = await cancelUnsettledRuns(hatchet, options, 'runs.cancelForTenant', id)
  // After the engine cancel, so a failed engine cancel leaves every outbox row pending.
  if (options.outbox !== undefined) {
    try {
      await cancelUnclaimedOutboxRows(options.outbox, { field: 'tenantId', id })
    } catch (cause) {
      throw new KyuError(`runs.cancelForTenant: could not cancel unclaimed outbox rows for tenant ${id}`, {
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      })
    }
  }
  return cancelled
}
