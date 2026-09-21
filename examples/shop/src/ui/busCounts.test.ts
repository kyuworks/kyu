import type { Queryable, QueryParam, RunOutcome, RunStatus, Unparsed } from '@kyuworks/sdk'
import { describe, expect, it } from 'vitest'
import type { BusTopology } from './busTopology.js'
import type { RunsSource } from './busCounts.js'
import { ENGINE_WINDOW_LIMIT, readBusCounts } from './busCounts.js'

interface RecordedQuery {
  text: string
  params: readonly QueryParam[]
}

interface FakeDb {
  db: Queryable
  queries: RecordedQuery[]
}

// Each call returns the next entry in `responses`, so a test can hand back
// exactly what each of readBusCounts's own queries expects, in order.
function fakeDb(responses: readonly Unparsed[][]): FakeDb {
  const queries: RecordedQuery[] = []
  let call = 0
  const db: Queryable = {
    query: (text: string, params: readonly QueryParam[]) => {
      queries.push({ text, params })
      const rows = responses[call] ?? []
      call += 1
      return Promise.resolve({ rows, rowCount: rows.length })
    },
  }
  return { db, queries }
}

// Returns exactly the outcomes queued for an envelope id, nothing else, so a
// test controls the engine fan-out without a real client.
function fakeRuns(byEnvelope: Readonly<Record<string, readonly RunOutcome[]>>): RunsSource {
  return { forEnvelope: (envelopeId: string) => Promise.resolve(byEnvelope[envelopeId] ?? []) }
}

let outcomeSeq = 0
function outcome(subscription: string, status: RunStatus, overrides: Partial<RunOutcome> = {}): RunOutcome {
  outcomeSeq += 1
  return {
    subscription,
    status,
    attempts: 1,
    runId: `run-${String(outcomeSeq)}`,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

const topologyWithDurable: BusTopology = {
  producer: { source: 'shop' },
  subscriptions: [
    { name: 'record-order', messageName: 'shop.order.placed', kind: 'event' },
    { name: 'send-invoice', messageName: 'shop.invoice.send', kind: 'command' },
    {
      name: 'watch-shipping',
      messageName: 'shop.order.placed',
      kind: 'event',
      doneOutcomes: [
        { handler: 'watch-shipping:completed', label: 'shipped' },
        { handler: 'watch-shipping:timeout', label: 'timed out' },
      ],
      waitingHandler: 'watch-shipping:waiting',
    },
  ],
}

describe('readBusCounts', () => {
  it('assembles producers, outbox and per-subscription counts from the stubbed rows', async () => {
    const { db, queries } = fakeDb([
      [{ source: 'shop', published: 9, waiting: 2, retired: 0 }],
      [{ id: 'env-1', name: 'shop.order.placed' }],
      [],
    ])
    const runs = fakeRuns({ 'env-1': [outcome('record-order', 'completed')] })

    const counts = await readBusCounts(db, runs, topologyWithDurable)

    expect(counts.producers).toEqual([{ source: 'shop', published: 9 }])
    expect(counts.outbox).toEqual({ published: 9, waitingForRelay: 2, shipped: 7, retired: 0 })
    expect(counts.window).toEqual({ limit: ENGINE_WINDOW_LIMIT, envelopes: 1, engineCalls: 1 })
    expect(queries).toHaveLength(3)
  })

  it('counts a failed run as failed for its subscription and never as done', async () => {
    const { db } = fakeDb([
      [{ source: 'shop', published: 1, waiting: 0, retired: 0 }],
      [{ id: 'env-1', name: 'shop.invoice.send' }],
      [],
    ])
    const runs = fakeRuns({ 'env-1': [outcome('send-invoice', 'failed')] })

    const counts = await readBusCounts(db, runs, topologyWithDurable)

    const sendInvoice = counts.subscriptions.find((subscription) => subscription.name === 'send-invoice')
    expect(sendInvoice?.failed).toBe(1)
    expect(sendInvoice?.completed).toBe(0)
  })

  it('reports a running run as parked only when the log has the waiting handler and no done handler (M5)', async () => {
    const { db } = fakeDb([
      [{ source: 'shop', published: 1, waiting: 0, retired: 0 }],
      [{ id: 'env-1', name: 'shop.order.placed' }],
      [{ envelope_id: 'env-1', handler: 'watch-shipping:waiting' }],
    ])
    const runs = fakeRuns({ 'env-1': [outcome('watch-shipping', 'running')] })

    const counts = await readBusCounts(db, runs, topologyWithDurable)

    const watchShipping = counts.subscriptions.find((subscription) => subscription.name === 'watch-shipping')
    expect(watchShipping?.running).toBe(1)
    expect(watchShipping?.parked).toBe(1)
  })

  it('never reports a running run parked once a done handler has logged for its envelope', async () => {
    const { db } = fakeDb([
      [{ source: 'shop', published: 1, waiting: 0, retired: 0 }],
      [{ id: 'env-1', name: 'shop.order.placed' }],
      [
        { envelope_id: 'env-1', handler: 'watch-shipping:waiting' },
        { envelope_id: 'env-1', handler: 'watch-shipping:completed' },
      ],
    ])
    const runs = fakeRuns({ 'env-1': [outcome('watch-shipping', 'running')] })

    const counts = await readBusCounts(db, runs, topologyWithDurable)

    const watchShipping = counts.subscriptions.find((subscription) => subscription.name === 'watch-shipping')
    expect(watchShipping?.parked).toBe(0)
  })

  it('a running run with no waiting-handler log row is never parked', async () => {
    const { db } = fakeDb([
      [{ source: 'shop', published: 1, waiting: 0, retired: 0 }],
      [{ id: 'env-1', name: 'shop.order.placed' }],
      [],
    ])
    const runs = fakeRuns({ 'env-1': [outcome('watch-shipping', 'running')] })

    const counts = await readBusCounts(db, runs, topologyWithDurable)

    const watchShipping = counts.subscriptions.find((subscription) => subscription.name === 'watch-shipping')
    expect(watchShipping?.parked).toBe(0)
  })

  // The split is not bounded by `completed`: a handler commits its log row
  // before the engine marks the run completed (busCounts.ts's foldBusCounts
  // comment), so the two can briefly disagree. This only proves the split
  // counts distinct envelopes per label.
  it('splits done by distinct window envelopes per label', async () => {
    const { db } = fakeDb([
      [{ source: 'shop', published: 2, waiting: 0, retired: 0 }],
      [
        { id: 'env-1', name: 'shop.order.placed' },
        { id: 'env-2', name: 'shop.order.placed' },
      ],
      [
        { envelope_id: 'env-1', handler: 'watch-shipping:completed' },
        { envelope_id: 'env-2', handler: 'watch-shipping:timeout' },
      ],
    ])
    const runs = fakeRuns({
      'env-1': [outcome('watch-shipping', 'completed')],
      'env-2': [outcome('watch-shipping', 'completed')],
    })

    const counts = await readBusCounts(db, runs, topologyWithDurable)

    const watchShipping = counts.subscriptions.find((subscription) => subscription.name === 'watch-shipping')
    expect(watchShipping?.completed).toBe(2)
    expect(watchShipping?.doneOutcomes).toEqual([
      { label: 'shipped', count: 1 },
      { label: 'timed out', count: 1 },
    ])
  })

  it('never lets a redelivered envelope inflate the done split past distinct envelopes', async () => {
    const { db } = fakeDb([
      [{ source: 'shop', published: 1, waiting: 0, retired: 0 }],
      [{ id: 'env-1', name: 'shop.order.placed' }],
      [{ envelope_id: 'env-1', handler: 'watch-shipping:completed' }],
    ])
    // Delivery is at-least-once: two runs for the same envelope, both completed.
    const runs = fakeRuns({
      'env-1': [outcome('watch-shipping', 'completed'), outcome('watch-shipping', 'completed')],
    })

    const counts = await readBusCounts(db, runs, topologyWithDurable)

    const watchShipping = counts.subscriptions.find((subscription) => subscription.name === 'watch-shipping')
    expect(watchShipping?.completed).toBe(2)
    expect(watchShipping?.doneOutcomes).toEqual([
      { label: 'shipped', count: 1 },
      { label: 'timed out', count: 0 },
    ])
  })

  it('gives a plain subscription no parked key and no doneOutcomes key', async () => {
    const { db } = fakeDb([
      [{ source: 'shop', published: 1, waiting: 0, retired: 0 }],
      [{ id: 'env-1', name: 'shop.order.placed' }],
      [],
    ])
    const runs = fakeRuns({ 'env-1': [outcome('record-order', 'completed')] })

    const counts = await readBusCounts(db, runs, topologyWithDurable)

    const recordOrder = counts.subscriptions.find((subscription) => subscription.name === 'record-order')
    expect(recordOrder).toEqual({ name: 'record-order', queued: 0, running: 0, completed: 1, failed: 0, cancelled: 0 })
    expect(recordOrder?.parked).toBeUndefined()
    expect(recordOrder?.doneOutcomes).toBeUndefined()
  })

  it('ignores an outcome naming a subscription the topology does not have', async () => {
    const { db } = fakeDb([
      [{ source: 'shop', published: 1, waiting: 0, retired: 0 }],
      [{ id: 'env-1', name: 'shop.order.placed' }],
      [],
    ])
    const runs = fakeRuns({ 'env-1': [outcome('unknown-subscription', 'completed')] })

    const counts = await readBusCounts(db, runs, topologyWithDurable)

    const total = counts.subscriptions.reduce(
      (sum, subscription) =>
        sum +
        subscription.queued +
        subscription.running +
        subscription.completed +
        subscription.failed +
        subscription.cancelled,
      0,
    )
    expect(total).toBe(0)
  })

  it('sets window.engineCalls to the number of window rows and never asks the engine about a row outside it', async () => {
    const { db, queries } = fakeDb([
      [{ source: 'shop', published: 1, waiting: 0, retired: 0 }],
      [{ id: 'env-1', name: 'shop.order.placed' }],
      [],
    ])
    const asked: string[] = []
    const runs: RunsSource = {
      forEnvelope: (envelopeId: string) => {
        asked.push(envelopeId)
        return Promise.resolve([])
      },
    }

    const counts = await readBusCounts(db, runs, topologyWithDurable)

    expect(counts.window).toEqual({ limit: ENGINE_WINDOW_LIMIT, envelopes: 1, engineCalls: 1 })
    expect(asked).toEqual(['env-1'])
    const windowQuery = queries.at(1)
    expect(windowQuery?.params[0]).toContain('shop.order.placed')
    expect(windowQuery?.params[0]).toContain('shop.invoice.send')
    expect(windowQuery?.params[0]).not.toContain('shop.order.shipped')
    expect(windowQuery?.params[1]).toBe(ENGINE_WINDOW_LIMIT)
  })

  it('skips the handler-log round trip when no subscription declares a waiting handler or done outcomes', async () => {
    const plainTopology: BusTopology = {
      producer: { source: 'shop' },
      subscriptions: [{ name: 'record-order', messageName: 'shop.order.placed', kind: 'event' }],
    }
    const { db, queries } = fakeDb([
      [{ source: 'shop', published: 1, waiting: 0, retired: 0 }],
      [{ id: 'env-1', name: 'shop.order.placed' }],
    ])
    const runs = fakeRuns({ 'env-1': [outcome('record-order', 'completed')] })

    await readBusCounts(db, runs, plainTopology)

    expect(queries).toHaveLength(2)
  })

  it('skips the handler-log round trip when the window is empty, even with a waiting handler declared', async () => {
    const { db, queries } = fakeDb([[{ source: 'shop', published: 0, waiting: 0, retired: 0 }], []])

    await readBusCounts(db, fakeRuns({}), topologyWithDurable)

    expect(queries).toHaveLength(2)
  })

  it('defaults a subscription with no matching outcome to zero', async () => {
    const { db } = fakeDb([[{ source: 'shop', published: 0, waiting: 0, retired: 0 }], [], []])

    const counts = await readBusCounts(db, fakeRuns({}), topologyWithDurable)

    expect(counts.subscriptions).toEqual([
      { name: 'record-order', queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
      { name: 'send-invoice', queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
      {
        name: 'watch-shipping',
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        parked: 0,
        doneOutcomes: [
          { label: 'shipped', count: 0 },
          { label: 'timed out', count: 0 },
        ],
      },
    ])
  })

  it('sums published and waiting across more than one producer source', async () => {
    const { db } = fakeDb([
      [
        { source: 'other', published: 1, waiting: 1, retired: 0 },
        { source: 'shop', published: 3, waiting: 1, retired: 0 },
      ],
      [],
      [],
    ])

    const counts = await readBusCounts(db, fakeRuns({}), topologyWithDurable)

    expect(counts.producers).toEqual([
      { source: 'other', published: 1 },
      { source: 'shop', published: 3 },
    ])
    expect(counts.outbox).toEqual({ published: 4, waitingForRelay: 2, shipped: 2, retired: 0 })
  })

  it('never counts a retired row as waiting, and counts it under retired', async () => {
    const { db, queries } = fakeDb([[{ source: 'shop', published: 5, waiting: 3, retired: 1 }], [], []])

    const counts = await readBusCounts(db, fakeRuns({}), topologyWithDurable)

    expect(counts.outbox).toEqual({ published: 5, waitingForRelay: 3, shipped: 1, retired: 1 })
    const producerQuery = queries.at(0)
    expect(producerQuery?.text).toContain('FILTER (WHERE published_at IS NULL AND dead_at IS NULL)')
    expect(producerQuery?.text).toContain('FILTER (WHERE dead_at IS NOT NULL)')
  })
})
