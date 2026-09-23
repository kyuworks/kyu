import { KyuError, V1TaskStatus } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import { toCheckedRunOutcomes } from './runOutcomes.js'
import type { RunDetailReader, RunOutcome } from './runOutcomes.js'

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

const UNSETTLED_STATUSES = [V1TaskStatus.QUEUED, V1TaskStatus.RUNNING]
const RUN_PAGE_LIMIT = 100
const RUN_MAX_PAGES = 200
const WORKFLOW_PAGE_LIMIT = 100
const WORKFLOW_MAX_PAGES = 10

/** The public method's name, so a thrown KyuError names what the caller called — mirrors runOutcomes.ts's RunLookup.caller. */
type NamespaceRunsCaller = 'runs.unsettledInNamespace' | 'runs.cancelUnsettledInNamespace'

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

/** Every run in this client's own namespace that the engine still holds queued or running, newest first. */
export async function readUnsettledRunsInNamespace(
  hatchet: NamespaceRunsClient,
  options: NamespaceRunsOptions,
): Promise<readonly RunOutcome[]> {
  const namespace = hatchet.config.namespace ?? ''
  if (namespace === '') return []
  const workflowNames = await namespaceWorkflowNames(hatchet, namespace, 'runs.unsettledInNamespace')
  if (workflowNames.length === 0) return []

  const rows: Awaited<ReturnType<NamespaceRunsClient['runs']['list']>>['rows'] = []
  for (let page = 0; page < RUN_MAX_PAGES; page += 1) {
    const result = await hatchet.runs.list({
      workflowNames: [...workflowNames],
      statuses: UNSETTLED_STATUSES,
      since: options.since,
      limit: RUN_PAGE_LIMIT,
      offset: page * RUN_PAGE_LIMIT,
      includePayloads: false,
    })
    rows.push(...result.rows)
    if (page + 1 >= (result.pagination.num_pages ?? 1)) {
      const outcomes = await toCheckedRunOutcomes(hatchet, rows, namespace, 'runs.unsettledInNamespace')
      return outcomes.filter((outcome) => outcome.status === 'queued' || outcome.status === 'running')
    }
  }
  throw new KyuError(
    `runs.unsettledInNamespace: more than ${String(RUN_MAX_PAGES * RUN_PAGE_LIMIT)} runs; narrow the window with options.since`,
  )
}

/**
 * Cancels every run this client's own namespace still holds queued or
 * running, and returns how many the engine reported cancelled. An engine
 * cancel filtered by an empty workflow list is not scoped to a namespace at
 * all, so a namespace with no registered workflow sends no cancel.
 */
export async function cancelUnsettledRunsInNamespace(
  hatchet: NamespaceRunsClient,
  options: NamespaceRunsOptions,
): Promise<number> {
  const namespace = hatchet.config.namespace ?? ''
  if (namespace === '') return 0
  const workflowNames = await namespaceWorkflowNames(hatchet, namespace, 'runs.cancelUnsettledInNamespace')
  if (workflowNames.length === 0) return 0

  try {
    const response = await hatchet.runs.cancel({
      filters: { workflowNames: [...workflowNames], statuses: UNSETTLED_STATUSES, since: options.since },
    })
    return (response.data.ids ?? []).length
  } catch (cause) {
    throw new KyuError(`runs.cancelUnsettledInNamespace: could not cancel runs in namespace "${namespace}"`, {
      cause: cause instanceof Error ? cause : new Error(String(cause)),
    })
  }
}
