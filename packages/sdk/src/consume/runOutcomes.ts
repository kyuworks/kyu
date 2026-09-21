import { envelopeSchema } from '@kyuworks/schemas'
import { KyuError } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import type { RunProgress } from './runProgress.js'

// A durable run parked in `sleepFor`/`waitFor` reads as `running`: the
// engine exposes no separate parked state.
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface RunOutcome {
  /** The subscription's name as the engine registered it, lowercased. */
  subscription: string
  /** `completed` is reported only once both timestamps exist, `failed` only once `finishedAt` does; until then the run reads `running`. */
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
  /** Ignore runs created before this. Default: 5 minutes before the id's own uuid v7 timestamp. */
  since?: Date
}

/** The envelope field the engine's run metadata is matched on. */
export type RunLookupKey = 'envelopeId' | 'correlationId'

export interface RunLookup {
  key: RunLookupKey
  /** A uuid v7: both `id` and `correlationId` on the envelope are uuid v7. */
  id: string
  /** The public method's name, so a thrown KyuError names what the caller called. */
  caller: 'runs.forEnvelope' | 'runs.forCorrelation' | 'runs.cancelForEnvelope' | 'runs.cancelForCorrelation'
}

export interface KyuRuns {
  forEnvelope(envelopeId: string, options?: ReadRunOutcomesOptions): Promise<readonly RunOutcome[]>
  /** Every run that shares this correlation id — a durable run and the command runs it published — oldest first, with what a parked run is waiting for. An unknown id returns an empty array. */
  forCorrelation(correlationId: string, options?: ReadRunOutcomesOptions): Promise<readonly RunProgress[]>
  /** Cancels every run the engine holds for this envelope id and returns them as they read just before the cancel. An unknown id returns an empty array. */
  cancelForEnvelope(envelopeId: string, options?: ReadRunOutcomesOptions): Promise<readonly RunOutcome[]>
  /** Cancels every run that shares this correlation id — a durable run and the command runs it published — and returns them as they read just before the cancel. An unknown id returns an empty array. */
  cancelForCorrelation(correlationId: string, options?: ReadRunOutcomesOptions): Promise<readonly RunOutcome[]>
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

// One envelope has one run per subscription times redeliveries, but
// `readRunOutcomesFor` also serves a correlation id: the durable run plus
// every command it published, times redeliveries, for a whole workflow run.
// 100 is reachable, so callers page instead of assuming one page is enough.
const RUN_PAGE_LIMIT = 100

// Hard ceiling on pages fetched for one lookup: RUN_PAGE_LIMIT * this many
// runs. Beyond it, the lookup id genuinely covers too much and the window
// needs narrowing with options.since rather than paging further.
const RUN_PAGE_MAX_PAGES = 10

// Clock skew between the producer and the engine. Wider than a typical clock
// drift: a producer more than a minute ahead would otherwise make every run
// for its envelopes vanish, indistinguishable from an unknown envelope id.
const SINCE_MARGIN_MS = 5 * 60_000

const LOOKUP_SCHEMA = {
  envelopeId: envelopeSchema.shape.id,
  correlationId: envelopeSchema.shape.correlationId,
}

/** A row outside this client's namespace belongs to another namespace in the same Hatchet tenant. */
export function toRunOutcome(row: EngineRunRow, namespace: string): RunOutcome | undefined {
  const workflowName = row.workflowName
  // A prefix match, not an exact namespace match: a sibling namespace that
  // extends this one (`shop_` also matches `shop_staging_`) is not filtered
  // out here. One Hatchet tenant per project per environment (design doc
  // "Delivery rules") is what keeps that from happening in production.
  if (workflowName === undefined || !workflowName.startsWith(namespace)) return undefined

  let status = RUN_STATUS[row.status]
  // The engine writes the terminal status before it writes startedAt/finishedAt,
  // so an unsettled completed row reads running. A failed row is different: a
  // run can fail before any worker starts it (scheduling timeout, could-not-
  // send-to-worker, rate limit) and never gets a startedAt, so only a missing
  // finishedAt — not a missing startedAt — holds a failed row back.
  if (status === 'completed' && (row.startedAt === undefined || row.finishedAt === undefined)) {
    status = 'running'
  } else if (status === 'failed' && row.finishedAt === undefined) {
    status = 'running'
  }

  const outcome: RunOutcome = {
    subscription: workflowName.slice(namespace.length),
    status,
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

// A run cannot predate the id it is looked up by: a uuid v7's own 48-bit
// timestamp is a cheap, always-available `since` default, computed only
// after the id is already known to be a well-formed uuid v7.
function uuidv7Timestamp(id: string): Date {
  const hex = id.replaceAll('-', '').slice(0, 12)
  return new Date(Number.parseInt(hex, 16))
}

/**
 * Every run the engine has recorded for one lookup id, newest first. An
 * unknown id returns an empty array. Delivery is at-least-once, so one
 * subscription can appear more than once.
 */
export async function readRunOutcomesFor(
  hatchet: RunsReader,
  lookup: RunLookup,
  options?: ReadRunOutcomesOptions,
): Promise<readonly RunOutcome[]> {
  const id = LOOKUP_SCHEMA[lookup.key].safeParse(lookup.id)
  if (!id.success) {
    throw new KyuError(`${lookup.caller}: "${lookup.id}" is not a uuid v7 ${lookup.key}`)
  }

  const since = options?.since ?? new Date(uuidv7Timestamp(lookup.id).getTime() - SINCE_MARGIN_MS)

  const additionalMetadata: Record<string, string> = {}
  additionalMetadata[lookup.key] = lookup.id

  const rows: EngineRunRow[] = []
  for (let page = 0; ; page += 1) {
    let result: Awaited<ReturnType<RunsReader['runs']['list']>>
    try {
      // `onlyTasks` is left unset (defaults false): every Kyu subscription
      // is a single-task workflow, so the broader default returns the same rows.
      result = await hatchet.runs.list({
        additionalMetadata,
        since,
        limit: RUN_PAGE_LIMIT,
        offset: page * RUN_PAGE_LIMIT,
        includePayloads: false,
      })
    } catch (cause) {
      throw new KyuError(`${lookup.caller}: could not read runs for ${lookup.key} ${lookup.id}`, {
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      })
    }

    const numPages = result.pagination.num_pages ?? 1
    if (numPages > RUN_PAGE_MAX_PAGES) {
      throw new KyuError(
        `${lookup.caller}: ${lookup.key} ${lookup.id} covers more than ${RUN_PAGE_MAX_PAGES * RUN_PAGE_LIMIT} runs; narrow the window with options.since`,
      )
    }

    rows.push(...result.rows)
    if (page + 1 >= numPages) break
  }

  const namespace = hatchet.config.namespace ?? ''
  const outcomes: RunOutcome[] = []
  for (const row of rows) {
    const outcome = toRunOutcome(row, namespace)
    if (outcome !== undefined) outcomes.push(outcome)
  }
  return outcomes
}

/**
 * Every run the engine has recorded for one envelope id, newest first. An
 * unknown envelope id returns an empty array. Delivery is at-least-once, so
 * one subscription can appear more than once.
 */
export function readRunOutcomes(
  hatchet: RunsReader,
  envelopeId: string,
  options?: ReadRunOutcomesOptions,
): Promise<readonly RunOutcome[]> {
  return readRunOutcomesFor(hatchet, { key: 'envelopeId', id: envelopeId, caller: 'runs.forEnvelope' }, options)
}
