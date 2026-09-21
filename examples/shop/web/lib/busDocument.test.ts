import { describe, expect, it } from 'vitest'
import type { BusCounts } from '../../src/ui/busCounts'
import type { BusTopology } from '../../src/ui/busTopology'
import { parseBusDocument } from './busDocument'

// Typed with the server's own exported types: a server shape change fails
// either this test or typecheck:tests before it ever reaches the browser.
const topology: BusTopology = {
  producer: { source: 'shop' },
  subscriptions: [
    { name: 'record-order', messageName: 'shop.order.placed', kind: 'event' },
    {
      name: 'watch-shipping',
      messageName: 'shop.order.placed',
      kind: 'event',
      doneOutcomes: [
        { handler: 'watch-shipping:completed', label: 'shipped' },
        { handler: 'watch-shipping:timeout', label: 'timed out' },
      ],
      waitingHandler: 'watch-shipping:waiting',
      wakesOn: { messageName: 'shop.order.shipped', label: 'shop.order.shipped wakes a parked run' },
    },
  ],
}

const counts: BusCounts = {
  producers: [{ source: 'shop', published: 5 }],
  outbox: { published: 5, waitingForRelay: 1, shipped: 4, retired: 0, scheduled: 0 },
  subscriptions: [
    { name: 'record-order', queued: 0, running: 0, completed: 5, failed: 0, cancelled: 0 },
    {
      name: 'watch-shipping',
      queued: 0,
      running: 1,
      completed: 3,
      failed: 0,
      cancelled: 0,
      parked: 1,
      doneOutcomes: [
        { label: 'shipped', count: 2 },
        { label: 'timed out', count: 1 },
      ],
    },
  ],
  window: { limit: 200, envelopes: 5, engineCalls: 5 },
}

describe('parseBusDocument', () => {
  it('parses a /bus.json body built from the server’s own types', () => {
    const outcome = parseBusDocument(JSON.stringify({ topology, counts }))

    expect(outcome).toEqual({ ok: true, document: { topology, counts } })
  })

  it('refuses a body that is not valid JSON', () => {
    const outcome = parseBusDocument('{not json')

    expect(outcome).toEqual({ ok: false, error: 'invalid JSON body' })
  })

  it('refuses a body missing topology', () => {
    const outcome = parseBusDocument(JSON.stringify({ counts }))

    expect(outcome.ok).toBe(false)
  })

  it('never omits a box: a topology entry with no matching counts entry still parses', () => {
    const outcome = parseBusDocument(JSON.stringify({ topology, counts: { ...counts, subscriptions: [] } }))

    expect(outcome.ok).toBe(true)
  })

  it('refuses an outbox block with no retired count', () => {
    const { retired: _retired, ...outboxWithoutRetired } = counts.outbox
    const outcome = parseBusDocument(JSON.stringify({ topology, counts: { ...counts, outbox: outboxWithoutRetired } }))

    expect(outcome.ok).toBe(false)
  })
})
