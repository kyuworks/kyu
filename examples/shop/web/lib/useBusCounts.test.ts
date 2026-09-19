import { describe, expect, it } from 'vitest'
import type { BusDocument } from './busDocument'
import type { JsonFetchOutcome } from './fetchJson'
import { nextBusState } from './useBusCounts'

const document: BusDocument = {
  topology: { producer: { source: 'shop' }, subscriptions: [] },
  counts: {
    producers: [{ source: 'shop', published: 1 }],
    outbox: { published: 1, waitingForRelay: 0, shipped: 1 },
    subscriptions: [],
    window: { limit: 200, envelopes: 1, engineCalls: 1 },
  },
}

const otherDocument: BusDocument = {
  ...document,
  counts: { ...document.counts, outbox: { published: 2, waitingForRelay: 1, shipped: 1 } },
}

function okOutcome(body: BusDocument): JsonFetchOutcome {
  return { ok: true, status: 200, bodyText: JSON.stringify(body) }
}

describe('nextBusState', () => {
  it('sets the document and clears a previous error on a good fetch', () => {
    const previous = { document: undefined, error: 'bus.json failed: stale' }

    const next = nextBusState(previous, okOutcome(document))

    expect(next).toEqual({ document, error: undefined })
  })

  it('replaces the document with a fresher one on a second good fetch', () => {
    const previous = { document, error: undefined }

    const next = nextBusState(previous, okOutcome(otherDocument))

    expect(next).toEqual({ document: otherDocument, error: undefined })
  })

  it('keeps the last good document and surfaces the server error on a non-2xx response', () => {
    const previous = { document, error: undefined }
    const outcome: JsonFetchOutcome = { ok: false, status: 500, bodyText: JSON.stringify({ error: 'engine down' }) }

    const next = nextBusState(previous, outcome)

    expect(next).toEqual({ document, error: 'bus.json failed: engine down' })
  })

  it('keeps the last good document and names the status when a non-2xx body has no error field', () => {
    const previous = { document, error: undefined }
    const outcome: JsonFetchOutcome = { ok: false, status: 503, bodyText: 'not json' }

    const next = nextBusState(previous, outcome)

    expect(next).toEqual({ document, error: 'bus.json failed: HTTP 503' })
  })

  it('keeps the last good document when a 200 body is not the agreed shape', () => {
    const previous = { document, error: undefined }
    const outcome: JsonFetchOutcome = { ok: true, status: 200, bodyText: JSON.stringify({ nope: true }) }

    const next = nextBusState(previous, outcome)

    expect(next.document).toBe(document)
    expect(next.error).toContain('bus.json failed:')
  })
})
