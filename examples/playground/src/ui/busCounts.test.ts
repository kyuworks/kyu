import type { Queryable, QueryParam, Unparsed } from '@kinesin/sdk'
import { describe, expect, it } from 'vitest'
import type { BusTopology } from './busTopology.js'
import { readBusCounts } from './busCounts.js'

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

const topologyWithDurable: BusTopology = {
  producer: { source: 'playground' },
  subscriptions: [
    { name: 'record-order', messageName: 'shop.order.placed', kind: 'event', doneHandlers: ['record-order'] },
    {
      name: 'watch-shipping',
      messageName: 'shop.order.placed',
      kind: 'event',
      doneHandlers: ['watch-shipping:completed', 'watch-shipping:timeout'],
      waitingHandler: 'watch-shipping:waiting',
    },
  ],
}

describe('readBusCounts', () => {
  it('assembles producer, bus and per-subscription counts from the stubbed rows', async () => {
    const { db, queries } = fakeDb([
      [{ count: 7 }],
      [
        { name: 'record-order', processed: 3 },
        { name: 'watch-shipping', processed: 1 },
      ],
      [{ name: 'watch-shipping', in_progress: 2 }],
      [{ count: 4 }],
    ])

    const counts = await readBusCounts(db, topologyWithDurable)

    expect(counts).toEqual({
      producer: { published: 7 },
      bus: { published: 7, inFlight: 4 },
      subscriptions: [
        { name: 'record-order', processed: 3 },
        { name: 'watch-shipping', processed: 1, inProgress: 2 },
      ],
    })
    expect(queries).toHaveLength(4)
  })

  it("passes each subscription's doneHandlers, owned by its own name, to the processed query", async () => {
    const { db, queries } = fakeDb([[{ count: 0 }], [], [{ name: 'watch-shipping', in_progress: 0 }], [{ count: 0 }]])

    await readBusCounts(db, topologyWithDurable)

    const processedQuery = queries.at(1)
    expect(processedQuery?.params[0]).toContain('record-order')
    expect(processedQuery?.params[0]).toContain('watch-shipping:completed')
    expect(processedQuery?.params[0]).toContain('watch-shipping:timeout')
    expect(processedQuery?.params[1]).toContain('watch-shipping')
  })

  it('passes the waitingHandler and the owning subscription name to the in-progress query', async () => {
    const { db, queries } = fakeDb([[{ count: 0 }], [], [{ name: 'watch-shipping', in_progress: 0 }], [{ count: 0 }]])

    await readBusCounts(db, topologyWithDurable)

    const inProgressQuery = queries.at(2)
    expect(inProgressQuery?.params[0]).toContain('watch-shipping')
    expect(inProgressQuery?.params[1]).toContain('watch-shipping:waiting')
  })

  it('passes each subscription name and messageName to the in-flight query', async () => {
    const { db, queries } = fakeDb([[{ count: 0 }], [], [{ name: 'watch-shipping', in_progress: 0 }], [{ count: 0 }]])

    await readBusCounts(db, topologyWithDurable)

    const inFlightQuery = queries.at(3)
    expect(inFlightQuery?.params[0]).toContain('record-order')
    expect(inFlightQuery?.params[0]).toContain('watch-shipping')
    expect(inFlightQuery?.params[1]).toContain('shop.order.placed')
  })

  it('skips the in-progress round trip when no subscription has a waitingHandler', async () => {
    const topology: BusTopology = {
      producer: { source: 'playground' },
      subscriptions: [
        { name: 'record-order', messageName: 'shop.order.placed', kind: 'event', doneHandlers: ['record-order'] },
      ],
    }
    const { db, queries } = fakeDb([[{ count: 2 }], [{ name: 'record-order', processed: 2 }], [{ count: 0 }]])

    const counts = await readBusCounts(db, topology)

    expect(queries).toHaveLength(3)
    expect(counts.subscriptions).toEqual([{ name: 'record-order', processed: 2 }])
    expect(counts.subscriptions.at(0)?.inProgress).toBeUndefined()
  })

  it('defaults a subscription with no matching row to zero', async () => {
    const { db } = fakeDb([[{ count: 0 }], [], [], [{ count: 0 }]])

    const counts = await readBusCounts(db, topologyWithDurable)

    expect(counts.subscriptions).toEqual([
      { name: 'record-order', processed: 0 },
      { name: 'watch-shipping', processed: 0, inProgress: 0 },
    ])
  })
})
