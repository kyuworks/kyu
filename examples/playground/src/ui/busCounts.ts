import type { QueryParam, QueryRows } from '@kinesin/sdk'
import { z } from 'zod'
import type { BusTopology } from './busTopology.js'

export interface SubscriptionCounts {
  name: string
  processed: number
  inProgress?: number
}

export interface BusCounts {
  producer: { published: number }
  bus: { published: number; inFlight: number }
  subscriptions: SubscriptionCounts[]
}

// @kinesin/sdk's Queryable rejects a Pool by design (its `totalCount?: never`
// guard, see db/queryable.ts): a Pool runs each query on its own connection,
// wrong for a publish transaction but fine for these four independent reads.
// A Pool, a PoolClient and a Queryable all structurally satisfy this.
export interface CountsSource {
  query(text: string, params: readonly QueryParam[]): Promise<QueryRows>
}

// Postgres array literal for `unnest($n::text[])`; readonly string[] is not a
// QueryParam (@kinesin/sdk's db/queryable.ts), so every array goes through here.
function textArrayLiteral(values: readonly string[]): string {
  return `{${values.map((value) => JSON.stringify(value)).join(',')}}`
}

const countRowSchema = z.object({ count: z.coerce.number().int() })
const processedRowSchema = z.object({ name: z.string(), processed: z.coerce.number().int() })
const inProgressRowSchema = z.object({ name: z.string(), in_progress: z.coerce.number().int() })

interface DoneHandlerLiterals {
  handlers: string
  owners: string
}

// One row per (subscription, doneHandler) pair — the join the processed,
// in-progress and in-flight queries all share to find a subscription's handlers.
function doneHandlerLiterals(topology: BusTopology): DoneHandlerLiterals {
  const handlers: string[] = []
  const owners: string[] = []
  for (const subscription of topology.subscriptions) {
    for (const handler of subscription.doneHandlers) {
      handlers.push(handler)
      owners.push(subscription.name)
    }
  }
  return { handlers: textArrayLiteral(handlers), owners: textArrayLiteral(owners) }
}

// The playground relay never prunes kinesin_outbox, so its row count is the
// total ever published (design decided in issue #56).
async function readPublishedCount(db: CountsSource): Promise<number> {
  const result = await db.query('SELECT count(*)::int AS count FROM kinesin_outbox', [])
  return countRowSchema.parse(result.rows[0]).count
}

async function readProcessedCounts(db: CountsSource, topology: BusTopology): Promise<Map<string, number>> {
  const { handlers, owners } = doneHandlerLiterals(topology)
  const result = await db.query(
    `WITH handlers AS (
       SELECT * FROM unnest($1::text[], $2::text[]) AS t(handler, name)
     )
     SELECT h.name AS name, count(DISTINCT l.envelope_id)::int AS processed
     FROM handlers h
     JOIN shop_handler_log l ON l.handler = h.handler
     GROUP BY h.name`,
    [handlers, owners],
  )
  const counts = new Map<string, number>()
  for (const raw of result.rows) {
    const row = processedRowSchema.parse(raw)
    counts.set(row.name, row.processed)
  }
  return counts
}

async function readInProgressCounts(db: CountsSource, topology: BusTopology): Promise<Map<string, number>> {
  const waitingNames: string[] = []
  const waitingHandlers: string[] = []
  for (const subscription of topology.subscriptions) {
    if (subscription.waitingHandler !== undefined) {
      waitingNames.push(subscription.name)
      waitingHandlers.push(subscription.waitingHandler)
    }
  }
  const counts = new Map<string, number>()
  if (waitingNames.length === 0) return counts

  const { handlers, owners } = doneHandlerLiterals(topology)
  const result = await db.query(
    `WITH waiting AS (
       SELECT * FROM unnest($1::text[], $2::text[]) AS t(name, waiting_handler)
     ), done AS (
       SELECT * FROM unnest($3::text[], $4::text[]) AS t(handler, name)
     )
     SELECT w.name AS name, count(DISTINCT wl.envelope_id)::int AS in_progress
     FROM waiting w
     JOIN shop_handler_log wl ON wl.handler = w.waiting_handler
     WHERE NOT EXISTS (
       SELECT 1
       FROM shop_handler_log dl
       JOIN done d ON d.handler = dl.handler AND d.name = w.name
       WHERE dl.envelope_id = wl.envelope_id
     )
     GROUP BY w.name`,
    [textArrayLiteral(waitingNames), textArrayLiteral(waitingHandlers), handlers, owners],
  )
  for (const raw of result.rows) {
    const row = inProgressRowSchema.parse(raw)
    counts.set(row.name, row.in_progress)
  }
  return counts
}

// An outbox row is in flight while any subscription on its message name has
// not yet written a done row for it (issue #56's "in flight" definition).
async function readInFlightCount(db: CountsSource, topology: BusTopology): Promise<number> {
  const names = topology.subscriptions.map((subscription) => subscription.name)
  const messageNames = topology.subscriptions.map((subscription) => subscription.messageName)
  const { handlers, owners } = doneHandlerLiterals(topology)

  const result = await db.query(
    `WITH subs AS (
       SELECT * FROM unnest($1::text[], $2::text[]) AS t(name, message_name)
     ), handlers AS (
       SELECT * FROM unnest($3::text[], $4::text[]) AS t(handler, name)
     )
     SELECT count(DISTINCT o.id)::int AS count
     FROM kinesin_outbox o
     JOIN subs s ON s.message_name = o.name
     WHERE NOT EXISTS (
       SELECT 1
       FROM shop_handler_log l
       JOIN handlers h ON h.handler = l.handler AND h.name = s.name
       WHERE l.envelope_id = o.id
     )`,
    [textArrayLiteral(names), textArrayLiteral(messageNames), handlers, owners],
  )
  return countRowSchema.parse(result.rows[0]).count
}

/** Assembles the bus diagram's counts from the playground database; no engine call (busTopology.ts). */
export async function readBusCounts(db: CountsSource, topology: BusTopology): Promise<BusCounts> {
  const published = await readPublishedCount(db)
  const processed = await readProcessedCounts(db, topology)
  const inProgress = await readInProgressCounts(db, topology)
  const inFlight = await readInFlightCount(db, topology)

  const subscriptions: SubscriptionCounts[] = topology.subscriptions.map((subscription) => {
    const counts: SubscriptionCounts = { name: subscription.name, processed: processed.get(subscription.name) ?? 0 }
    if (subscription.waitingHandler !== undefined) {
      counts.inProgress = inProgress.get(subscription.name) ?? 0
    }
    return counts
  })

  return { producer: { published }, bus: { published, inFlight }, subscriptions }
}
