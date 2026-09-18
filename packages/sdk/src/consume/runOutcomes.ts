import { envelopeSchema } from '@qtaxis/schemas'
import { QtaxisError } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'

// A durable run parked in `sleepFor`/`waitFor` reads as `running`: the
// engine exposes no separate parked state.
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface RunOutcome {
  /** The subscription's name as the engine registered it, lowercased. */
  subscription: string
  status: RunStatus
  /** The engine's own attempt number, 1 on the first try; a queued run — none picked up yet — also reads 1. */
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
  /** Ignore runs created before this. Default: 5 minutes before the envelope id's own uuid v7 timestamp. */
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

// Clock skew between the producer and the engine. Wider than a typical clock
// drift: a producer more than a minute ahead would otherwise make every run
// for its envelopes vanish, indistinguishable from an unknown envelope id.
const SINCE_MARGIN_MS = 5 * 60_000

/** A row outside this client's namespace belongs to another namespace in the same Hatchet tenant. */
export function toRunOutcome(row: EngineRunRow, namespace: string): RunOutcome | undefined {
  const workflowName = row.workflowName
  // A prefix match, not an exact namespace match: a sibling namespace that
  // extends this one (`shop_` also matches `shop_staging_`) is not filtered
  // out here. One Hatchet tenant per project per environment (design doc
  // "Delivery rules") is what keeps that from happening in production.
  if (workflowName === undefined || !workflowName.startsWith(namespace)) return undefined

  const outcome: RunOutcome = {
    subscription: workflowName.slice(namespace.length),
    status: RUN_STATUS[row.status],
    // The engine's own `attempt` is the source of truth; `retryCount + 1`
    // is a fallback for the rare row where `attempt` itself is absent.
    attempts: row.attempt ?? (row.retryCount ?? 0) + 1,
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
    // `onlyTasks` is left unset (defaults false): every Qtaxis subscription
    // is a single-task workflow, so the broader default returns the same rows.
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
