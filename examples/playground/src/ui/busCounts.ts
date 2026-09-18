import type { QueryParam, QueryRows, RunOutcome } from '@qtaxis/sdk'
import { z } from 'zod'
import type { BusTopology, TopologySubscription } from './busTopology.js'

export interface ProducerCounts {
  source: string
  published: number
}

export interface OutboxCounts {
  published: number
  waitingForRelay: number
  shipped: number
}

export interface DoneOutcomeCount {
  label: string
  count: number
}

export interface SubscriptionRunCounts {
  name: string
  queued: number
  running: number
  completed: number
  failed: number
  cancelled: number
  /** Durable only: of `running`, the runs parked in the handler's wait. */
  parked?: number
  /** Durable only: `completed` split by the outcome the handler logged. */
  doneOutcomes?: DoneOutcomeCount[]
}

/** What the engine numbers cover; the page prints this so the reader is not misled. */
export interface CountsWindow {
  limit: number
  envelopes: number
  engineCalls: number
}

export interface BusCounts {
  producers: ProducerCounts[]
  outbox: OutboxCounts
  subscriptions: SubscriptionRunCounts[]
  window: CountsWindow
}

// @qtaxis/sdk's Queryable rejects a Pool by design (db/queryable.ts's
// `totalCount?: never`); a Pool, PoolClient and Queryable all satisfy this.
export interface CountsSource {
  query(text: string, params: readonly QueryParam[]): Promise<QueryRows>
}

// Narrowed to what this file needs, so the unit test's fake is a plain object
// (packages/sdk/src/consume/runOutcomes.ts's own RunsReader does the same).
export interface RunsSource {
  forEnvelope(envelopeId: string): Promise<readonly RunOutcome[]>
}

// The newest N outbox rows the engine is asked about per refresh. Measured
// cost is ~4ms per call locally, so 200 calls stay well under a second.
export const ENGINE_WINDOW_LIMIT = 200

// Bounds the engine fan-out burst; a short local helper, not a dependency.
const ENGINE_CONCURRENCY = 8

// Postgres array literal for `unnest($n::text[])`; readonly string[] is not a QueryParam.
function textArrayLiteral(values: readonly string[]): string {
  return `{${values.map((value) => JSON.stringify(value)).join(',')}}`
}

const producerTotalsRowSchema = z.object({
  source: z.string(),
  published: z.coerce.number().int(),
  waiting: z.coerce.number().int(),
})
const windowRowSchema = z.object({ id: z.string(), name: z.string() })
const handlerLogRowSchema = z.object({ envelope_id: z.string(), handler: z.string() })

type ProducerTotalsRow = z.infer<typeof producerTotalsRowSchema>
type WindowRow = z.infer<typeof windowRowSchema>

interface HandlerLogRow {
  envelopeId: string
  handler: string
}

// Producer and outbox totals, lifetime, every row: envelope->>'source' is the
// only place a producer's name lives, since qtaxis_outbox has no source column.
async function readProducerTotals(db: CountsSource): Promise<ProducerTotalsRow[]> {
  const result = await db.query(
    `SELECT envelope->>'source' AS source,
            count(*)::int AS published,
            count(*) FILTER (WHERE published_at IS NULL)::int AS waiting
     FROM qtaxis_outbox
     GROUP BY 1
     ORDER BY 1`,
    [],
  )
  return result.rows.map((row) => producerTotalsRowSchema.parse(row))
}

// The newest rows whose name has a subscription — the window the engine fan-out asks about.
async function readWindowEnvelopes(db: CountsSource, topology: BusTopology): Promise<WindowRow[]> {
  const messageNames = Array.from(new Set(topology.subscriptions.map((subscription) => subscription.messageName)))
  const result = await db.query(
    `SELECT id::text AS id, name
     FROM qtaxis_outbox
     WHERE name IN (SELECT * FROM unnest($1::text[]))
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [textArrayLiteral(messageNames), ENGINE_WINDOW_LIMIT],
  )
  return result.rows.map((row) => windowRowSchema.parse(row))
}

// Handlers this topology actually logs against: a waitingHandler plus every
// doneOutcomes[].handler. A plain subscription contributes neither.
function loggedHandlers(topology: BusTopology): string[] {
  const handlers: string[] = []
  for (const subscription of topology.subscriptions) {
    if (subscription.waitingHandler !== undefined) handlers.push(subscription.waitingHandler)
    for (const outcome of subscription.doneOutcomes ?? []) handlers.push(outcome.handler)
  }
  return handlers
}

// Handler log rows for the window, only for handlers the topology declares;
// skipped entirely when nothing does (mirrors the old file's in-progress skip).
async function readHandlerLogRows(
  db: CountsSource,
  topology: BusTopology,
  windowRows: readonly WindowRow[],
): Promise<HandlerLogRow[]> {
  const handlers = loggedHandlers(topology)
  if (handlers.length === 0) return []

  const result = await db.query(
    `SELECT DISTINCT envelope_id::text AS envelope_id, handler
     FROM shop_handler_log
     WHERE handler IN (SELECT * FROM unnest($1::text[]))
       AND envelope_id IN (SELECT * FROM unnest($2::uuid[]))`,
    [textArrayLiteral(handlers), textArrayLiteral(windowRows.map((row) => row.id))],
  )
  return result.rows.map((raw) => {
    const row = handlerLogRowSchema.parse(raw)
    return { envelopeId: row.envelope_id, handler: row.handler }
  })
}

// Runs `fn` over `items` with at most `limit` in flight at once.
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from<R>({ length: items.length })
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      results[index] = await fn(item)
    }
  }
  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

interface CountsBucket {
  queued: number
  running: number
  completed: number
  failed: number
  cancelled: number
  parked: number
}

function emptyBucket(): CountsBucket {
  return { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, parked: 0 }
}

// A run the engine calls "running" is parked only when the log shows this
// subscription's own waiting row and no done row yet for this envelope (M5).
function isParked(
  subscription: TopologySubscription,
  envelopeId: string,
  logByEnvelope: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (subscription.waitingHandler === undefined) return false
  const handlers = logByEnvelope.get(envelopeId)
  if (handlers === undefined || !handlers.has(subscription.waitingHandler)) return false
  return !(subscription.doneOutcomes ?? []).some((outcome) => handlers.has(outcome.handler))
}

function foldBusCounts(
  topology: BusTopology,
  producerRows: readonly ProducerTotalsRow[],
  windowRows: readonly WindowRow[],
  outcomesByEnvelope: ReadonlyMap<string, readonly RunOutcome[]>,
  handlerLogRows: readonly HandlerLogRow[],
): BusCounts {
  const producers: ProducerCounts[] = producerRows.map((row) => ({ source: row.source, published: row.published }))
  const published = producerRows.reduce((sum, row) => sum + row.published, 0)
  const waitingForRelay = producerRows.reduce((sum, row) => sum + row.waiting, 0)
  const outbox: OutboxCounts = { published, waitingForRelay, shipped: published - waitingForRelay }

  const logByEnvelope = new Map<string, Set<string>>()
  const envelopesByHandler = new Map<string, Set<string>>()
  for (const row of handlerLogRows) {
    const handlerSet = logByEnvelope.get(row.envelopeId) ?? new Set<string>()
    handlerSet.add(row.handler)
    logByEnvelope.set(row.envelopeId, handlerSet)

    const envelopeSet = envelopesByHandler.get(row.handler) ?? new Set<string>()
    envelopeSet.add(row.envelopeId)
    envelopesByHandler.set(row.handler, envelopeSet)
  }

  const bySubscriptionName = new Map(
    topology.subscriptions.map((subscription) => [subscription.name.toLowerCase(), subscription]),
  )
  const buckets = new Map<string, CountsBucket>(
    topology.subscriptions.map((subscription) => [subscription.name, emptyBucket()]),
  )

  for (const row of windowRows) {
    const outcomes = outcomesByEnvelope.get(row.id) ?? []
    for (const runOutcome of outcomes) {
      const subscription = bySubscriptionName.get(runOutcome.subscription.toLowerCase())
      if (subscription === undefined) continue
      const bucket = buckets.get(subscription.name)
      if (bucket === undefined) continue
      bucket[runOutcome.status] += 1
      if (runOutcome.status === 'running' && isParked(subscription, row.id, logByEnvelope)) {
        bucket.parked += 1
      }
    }
  }

  const subscriptions: SubscriptionRunCounts[] = topology.subscriptions.map((subscription) => {
    const bucket = buckets.get(subscription.name) ?? emptyBucket()
    const counts: SubscriptionRunCounts = {
      name: subscription.name,
      queued: bucket.queued,
      running: bucket.running,
      completed: bucket.completed,
      failed: bucket.failed,
      cancelled: bucket.cancelled,
    }
    if (subscription.waitingHandler !== undefined) counts.parked = bucket.parked
    if (subscription.doneOutcomes !== undefined) {
      counts.doneOutcomes = subscription.doneOutcomes.map((outcome) => ({
        label: outcome.label,
        count: envelopesByHandler.get(outcome.handler)?.size ?? 0,
      }))
    }
    return counts
  })

  return {
    producers,
    outbox,
    subscriptions,
    window: { limit: ENGINE_WINDOW_LIMIT, envelopes: windowRows.length, engineCalls: windowRows.length },
  }
}

/**
 * Assembles the bus diagram's counts: outbox stages from qtaxis_outbox, run
 * states from the engine through one `runs.forEnvelope` call per window
 * envelope, and watch-shipping's parked/done split from shop_handler_log.
 */
export async function readBusCounts(db: CountsSource, runs: RunsSource, topology: BusTopology): Promise<BusCounts> {
  const [producerRows, windowRows] = await Promise.all([readProducerTotals(db), readWindowEnvelopes(db, topology)])

  const [handlerLogRows, outcomesList] = await Promise.all([
    readHandlerLogRows(db, topology, windowRows),
    mapWithConcurrency(windowRows, ENGINE_CONCURRENCY, (row) => runs.forEnvelope(row.id)),
  ])

  const outcomesByEnvelope = new Map<string, readonly RunOutcome[]>(
    windowRows.map((row, index) => [row.id, outcomesList[index] ?? []]),
  )

  return foldBusCounts(topology, producerRows, windowRows, outcomesByEnvelope, handlerLogRows)
}
