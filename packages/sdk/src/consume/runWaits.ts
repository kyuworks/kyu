import { z } from 'zod'
import { KyuError } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import type { RunLookup } from './runOutcomes.js'

export type RunWait = { kind: 'sleep'; until: Date } | { kind: 'message'; name: string; field: string; equals: string }

// Narrowed to what this file actually needs, the same way RunsReader
// (runOutcomes.ts) is, so the unit test's fake is a plain object.
export interface DurableLogReader {
  tenantId: string
  api: Pick<HatchetClient['api'], 'v1DurableTaskEventLogList'>
}

type DurableLogEntry = Awaited<ReturnType<DurableLogReader['api']['v1DurableTaskEventLogList']>>['data'][number]
type DurableLogCondition = NonNullable<DurableLogEntry['waitData']>[number]

const WAIT_LABEL_PREFIX = 'kyu:1:'

/** The only channel a `waitFor` field match reaches the read side by: the engine's durable log has no CEL expression. */
export function toWaitLabel(where: { field: string; equals: string }): string {
  return `${WAIT_LABEL_PREFIX}${JSON.stringify({ field: where.field, equals: where.equals })}`
}

const waitLabelSchema = z.object({ field: z.string().min(1), equals: z.string() })

function parseWaitLabel(label: string | undefined): { field: string; equals: string } | undefined {
  if (label === undefined || !label.startsWith(WAIT_LABEL_PREFIX)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(label.slice(WAIT_LABEL_PREFIX.length))
  } catch {
    return undefined
  }
  const result = waitLabelSchema.safeParse(parsed)
  return result.success ? result.data : undefined
}

// One page of the durable log; the log has no pagination metadata like
// runs.list does, so a page that came back full is the only signal that more
// might follow.
const DURABLE_LOG_PAGE_LIMIT = 500

// data-contracts.d.ts:715-731: a WAIT_FOR entry's waitData is a list of
// conditions, each optionally wrapping an `or` of more conditions. The kind
// strings are that file's own enum members (v1/index.js does not re-export
// them to compare against).
function flattenConditions(entry: DurableLogEntry): DurableLogCondition[] {
  const top = entry.waitData ?? []
  const flat: DurableLogCondition[] = []
  for (const item of top) {
    flat.push(item)
    for (const nested of item.or ?? []) flat.push(nested)
  }
  return flat
}

// Neither a USER_EVENT nor a SLEEP condition is a wait kind Kyu's own
// waitFor()/sleepFor() never register (e.g. a bare CHILD_WORKFLOW); reported
// as no wait rather than invented or thrown.
function toRunWait(
  entry: DurableLogEntry,
  namespace: string,
  runId: string,
  caller: RunLookup['caller'],
): RunWait | undefined {
  const conditions = flattenConditions(entry)

  const userEvent = conditions.find((condition) => condition.kind === 'USER_EVENT')
  if (userEvent !== undefined) {
    const label = parseWaitLabel(entry.userMessage)
    if (label === undefined) {
      throw new KyuError(
        `${caller}: run ${runId} is waiting on ${userEvent.eventKey ?? '(unknown event)'} but its wait carries no Kyu label`,
      )
    }
    const eventKey = userEvent.eventKey ?? ''
    const name = eventKey.startsWith(namespace) ? eventKey.slice(namespace.length) : eventKey
    return { kind: 'message', name, field: label.field, equals: label.equals }
  }

  const sleep = conditions.find((condition) => condition.kind === 'SLEEP' && condition.sleepDurationMs !== undefined)
  if (sleep?.sleepDurationMs !== undefined) {
    return { kind: 'sleep', until: new Date(Date.parse(entry.insertedAt) + sleep.sleepDurationMs) }
  }

  return undefined
}

/**
 * The current wait for one durable run, or `undefined` when it is not
 * parked. The engine's durable log is oldest-first, so the whole page is
 * read; an entry stays unsatisfied for ever after a cancel, so callers only
 * ask this while the run's own status is `running`.
 */
export async function readRunWait(
  reader: DurableLogReader,
  runId: string,
  namespace: string,
  caller: RunLookup['caller'],
): Promise<RunWait | undefined> {
  let entries: DurableLogEntry[]
  try {
    const response = await reader.api.v1DurableTaskEventLogList(reader.tenantId, runId, {
      limit: DURABLE_LOG_PAGE_LIMIT,
    })
    entries = response.data
  } catch (cause) {
    throw new KyuError(`${caller}: could not read the durable log for run ${runId}`, {
      cause: cause instanceof Error ? cause : new Error(String(cause)),
    })
  }

  if (entries.length >= DURABLE_LOG_PAGE_LIMIT) {
    throw new KyuError(`${caller}: run ${runId} has more than ${DURABLE_LOG_PAGE_LIMIT} durable log entries`)
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry !== undefined && entry.kind === 'WAIT_FOR' && !entry.isSatisfied) {
      return toRunWait(entry, namespace, runId, caller)
    }
  }
  return undefined
}
