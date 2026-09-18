import { envelopeSchema } from '@qtaxis/schemas'
import { QtaxisError } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface RunOutcome {
  /** The subscription's own `name`, as `subscribe()`/`durable()` was given it. */
  subscription: string
  status: RunStatus
  /** The first try is 1. A run that never retried reads 1. */
  attempts: number
  /** The engine's run id. The dashboard link and a future replay use it. */
  runId: string
  /** When the engine created the run. Set on every run, including a queued one. */
  createdAt: Date
  startedAt?: Date
  finishedAt?: Date
  /** Only when the engine reported a non-empty message; a completed run has none. */
  error?: string
}

export interface ReadRunOutcomesOptions {
  /** Ignore runs created before this. Default: 60s before the envelope id's own uuid v7 timestamp. */
  since?: Date
}

export interface QtaxisRuns {
  forEnvelope(envelopeId: string, options?: ReadRunOutcomesOptions): Promise<readonly RunOutcome[]>
}

type EngineRunRow = Awaited<ReturnType<HatchetClient['runs']['list']>>['rows'][number]
type EngineStatus = EngineRunRow['status']

// Narrowed to what this file actually needs, so the unit test's fake is a plain object.
export interface RunsReader {
  config: Pick<HatchetClient['config'], 'namespace'>
  runs: Pick<HatchetClient['runs'], 'list'>
}

const RUN_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
} satisfies Record<EngineStatus, RunStatus>

// One envelope has one run per subscription times redeliveries; 100 cannot be
// reached without something being badly wrong.
const RUN_PAGE_LIMIT = 100

// Clock skew between the producer and the engine.
const SINCE_MARGIN_MS = 60_000

/** A row outside this client's namespace belongs to another namespace in the same Hatchet tenant. */
export function toRunOutcome(row: EngineRunRow, namespace: string): RunOutcome | undefined {
  const workflowName = row.workflowName
  if (workflowName === undefined || !workflowName.startsWith(namespace)) return undefined

  const outcome: RunOutcome = {
    subscription: workflowName.slice(namespace.length),
    status: RUN_STATUS[row.status],
    attempts: (row.retryCount ?? 0) + 1,
    runId: row.taskExternalId,
    createdAt: new Date(row.createdAt),
  }
  if (row.startedAt !== undefined) outcome.startedAt = new Date(row.startedAt)
  if (row.finishedAt !== undefined) outcome.finishedAt = new Date(row.finishedAt)
  if (row.errorMessage !== undefined && row.errorMessage !== '') outcome.error = row.errorMessage
  return outcome
}

// A run cannot predate its envelope: the uuid v7's own 48-bit timestamp is a
// cheap, always-available `since` default, computed only after the id is
// already known to be a well-formed uuid v7.
function envelopeIdTimestamp(envelopeId: string): Date {
  const hex = envelopeId.replaceAll('-', '').slice(0, 12)
  return new Date(Number.parseInt(hex, 16))
}

/**
 * Every run the engine has recorded for one envelope id, newest first. An
 * unknown envelope id returns an empty array. Delivery is at-least-once, so
 * one subscription can appear more than once.
 */
export async function readRunOutcomes(
  hatchet: RunsReader,
  envelopeId: string,
  options?: ReadRunOutcomesOptions,
): Promise<readonly RunOutcome[]> {
  const id = envelopeSchema.shape.id.safeParse(envelopeId)
  if (!id.success) {
    throw new QtaxisError(`runs.forEnvelope: "${envelopeId}" is not a uuid v7 envelope id`)
  }

  const since = options?.since ?? new Date(envelopeIdTimestamp(envelopeId).getTime() - SINCE_MARGIN_MS)

  let result: Awaited<ReturnType<RunsReader['runs']['list']>>
  try {
    result = await hatchet.runs.list({
      additionalMetadata: { envelopeId },
      since,
      limit: RUN_PAGE_LIMIT,
      includePayloads: false,
    })
  } catch (cause) {
    throw new QtaxisError(`runs.forEnvelope: could not read runs for envelope ${envelopeId}`, {
      cause: cause instanceof Error ? cause : new Error(String(cause)),
    })
  }

  if ((result.pagination.num_pages ?? 1) > 1) {
    throw new QtaxisError(
      `runs.forEnvelope: envelope ${envelopeId} has more than ${RUN_PAGE_LIMIT} runs; narrow the window with options.since`,
    )
  }

  const namespace = hatchet.config.namespace ?? ''
  const outcomes: RunOutcome[] = []
  for (const row of result.rows) {
    const outcome = toRunOutcome(row, namespace)
    if (outcome !== undefined) outcomes.push(outcome)
  }
  return outcomes
}
