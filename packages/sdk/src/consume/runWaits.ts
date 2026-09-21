import { z } from 'zod'
import { KyuError } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import type { RunLookup } from './runOutcomes.js'

export type RunWait =
  | { kind: 'sleep'; until: Date }
  | { kind: 'message'; name: string; match?: { field: string; equals: string } }
  /** A `waitForAny`: every name it is parked on, with the field match when the label decodes. */
  | { kind: 'anyMessage'; waits: readonly { name: string; match?: { field: string; equals: string } }[] }

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

/** One branch of a multi-name wait as the label records it. Flat, not a `MessageWait`, so `waitAny.ts` can import this file without a cycle. */
export interface WaitLabelEntry {
  name: string
  field: string
  equals: string
}

const ANY_WAIT_LABEL_PREFIX = 'kyu:2:'

/** The only channel a multi-name wait's field matches reach the read side by: the durable log has one event key per branch and no CEL. */
export function toAnyWaitLabel(entries: readonly WaitLabelEntry[]): string {
  return `${ANY_WAIT_LABEL_PREFIX}${JSON.stringify(entries)}`
}

const anyWaitLabelSchema = z
  .array(z.object({ name: z.string().min(1), field: z.string().min(1), equals: z.string() }))
  .min(1)

function parseAnyWaitLabel(label: string | undefined): WaitLabelEntry[] | undefined {
  if (label === undefined || !label.startsWith(ANY_WAIT_LABEL_PREFIX)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(label.slice(ANY_WAIT_LABEL_PREFIX.length))
  } catch {
    return undefined
  }
  const result = anyWaitLabelSchema.safeParse(parsed)
  return result.success ? result.data : undefined
}

function toMessageName(eventKey: string | undefined, namespace: string): string {
  const key = eventKey ?? ''
  return key.startsWith(namespace) ? key.slice(namespace.length) : key
}

// One page of the durable log; the log has no pagination metadata like
// runs.list does, so a page that came back full is the only signal that more
// might follow, and a page that came back short is the only signal that it
// was the last one.
const DURABLE_LOG_PAGE_LIMIT = 500

// Hard ceiling on pages fetched for one run's log: DURABLE_LOG_PAGE_LIMIT *
// this many entries, the same shape as RUN_PAGE_MAX_PAGES in runOutcomes.ts.
const DURABLE_LOG_MAX_PAGES = 10

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

// A wait kind Kyu never registers (e.g. a bare CHILD_WORKFLOW) reports no
// wait, rather than invented or thrown.
function toRunWait(entry: DurableLogEntry, namespace: string): RunWait | undefined {
  const conditions = flattenConditions(entry)

  const userEvents = conditions.filter((condition) => condition.kind === 'USER_EVENT')

  // Several user events in one entry is a waitForAny; the label is this SDK's
  // own record of the registration, the engine's condition list the fallback.
  if (userEvents.length > 1) {
    const label = parseAnyWaitLabel(entry.userMessage)
    const waits =
      label === undefined
        ? userEvents.map((condition) => ({ name: toMessageName(condition.eventKey, namespace) }))
        : label.map((item) => ({ name: item.name, match: { field: item.field, equals: item.equals } }))
    return { kind: 'anyMessage', waits }
  }

  const userEvent = userEvents[0]
  if (userEvent !== undefined) {
    const name = toMessageName(userEvent.eventKey, namespace)
    // A run parked by a worker on an older SDK, or one whose label a future
    // SDK cannot decode, carries no match rather than failing the whole read.
    const label = parseWaitLabel(entry.userMessage)
    return label === undefined
      ? { kind: 'message', name }
      : { kind: 'message', name, match: { field: label.field, equals: label.equals } }
  }

  const sleep = conditions.find((condition) => condition.kind === 'SLEEP' && condition.sleepDurationMs !== undefined)
  if (sleep?.sleepDurationMs !== undefined) {
    return { kind: 'sleep', until: new Date(Date.parse(entry.insertedAt) + sleep.sleepDurationMs) }
  }

  return undefined
}

/**
 * The current wait for one durable run, or `undefined` when it is not
 * parked. Pages the engine's durable log in `DURABLE_LOG_PAGE_LIMIT`-entry
 * batches, up to `DURABLE_LOG_MAX_PAGES`, and picks the unsatisfied
 * `WAIT_FOR` entry with the greatest `nodeId` — the current wait — so the
 * read does not depend on the endpoint's own ordering. An entry stays
 * unsatisfied for ever after a cancel, so callers only ask this while the
 * run's own status is `running`.
 */
export async function readRunWait(
  reader: DurableLogReader,
  runId: string,
  namespace: string,
  caller: RunLookup['caller'],
): Promise<RunWait | undefined> {
  const entries: DurableLogEntry[] = []
  for (let page = 0; ; page += 1) {
    let response: Awaited<ReturnType<DurableLogReader['api']['v1DurableTaskEventLogList']>>
    try {
      response = await reader.api.v1DurableTaskEventLogList(reader.tenantId, runId, {
        limit: DURABLE_LOG_PAGE_LIMIT,
        offset: page * DURABLE_LOG_PAGE_LIMIT,
      })
    } catch (cause) {
      throw new KyuError(`${caller}: could not read the durable log for run ${runId}`, {
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      })
    }

    entries.push(...response.data)
    // A short page is the only signal the log has no more entries; a full
    // page must be followed up, since a log of exactly one page's worth
    // would otherwise be mistaken for an overflow (the off-by-one this
    // replaces).
    if (response.data.length < DURABLE_LOG_PAGE_LIMIT) break
    if (page + 1 >= DURABLE_LOG_MAX_PAGES) {
      throw new KyuError(
        `${caller}: run ${runId} has more than ${DURABLE_LOG_MAX_PAGES * DURABLE_LOG_PAGE_LIMIT} durable log entries`,
      )
    }
  }

  let current: DurableLogEntry | undefined
  for (const entry of entries) {
    if (entry.kind !== 'WAIT_FOR' || entry.isSatisfied) continue
    if (current === undefined || entry.nodeId > current.nodeId) current = entry
  }
  return current === undefined ? undefined : toRunWait(current, namespace)
}
