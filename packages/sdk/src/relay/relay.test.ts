import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueryParam, Queryable, QueryRows } from '../db/queryable.js'
import type { HatchetClient } from '../hatchet.js'
import { outboxRowSchema } from '../outbox/rows.js'
import type { OutboxRow } from '../outbox/rows.js'
import { startRelay } from './relay.js'

function makeRow(id: string, name: string): OutboxRow {
  return outboxRowSchema.parse({
    id,
    name,
    tenant_id: null,
    envelope: {
      id,
      name,
      version: 1,
      kind: 'event',
      occurredAt: '2026-01-01T00:00:00.000Z',
      tenantId: null,
      correlationId: id,
      source: 'shop',
      data: {},
    },
    created_at: new Date(),
    claimed_at: new Date(),
    claimed_by: 'worker-1',
    published_at: null,
    attempts: 0,
    last_error: null,
  })
}

interface RecordedQuery {
  text: string
  params: readonly QueryParam[]
}

interface FakeDb {
  db: Queryable
  calls: RecordedQuery[]
}

// Mimics the shape of the real repository calls without a database: the
// claim query is matched by its `RETURNING *`, everything else is a no-op.
function createFakeDb(claimBatches: readonly OutboxRow[][]): FakeDb {
  const calls: RecordedQuery[] = []
  let claimIndex = 0
  const db: Queryable = {
    async query(text, params): Promise<QueryRows> {
      calls.push({ text, params })
      if (text.includes('RETURNING *')) {
        const rows = claimBatches[claimIndex] ?? []
        claimIndex += 1
        return { rows, rowCount: rows.length }
      }
      return { rows: [], rowCount: 0 }
    },
  }
  return { db, calls }
}

// `HatchetClient`/`EventClient` are engine classes with fields no fake can populate;
// each mock's own call signature (not vitest's richer `Mock` type) is what gets asserted.
function fakeEvents(bulkPush: ReturnType<typeof vi.fn>): HatchetClient['events'] {
  return { bulkPush: bulkPush as HatchetClient['events']['bulkPush'] } as HatchetClient['events']
}

interface FakeHatchet {
  hatchet: HatchetClient
  bulkPush: ReturnType<typeof vi.fn>
}

function createFakeHatchet(): FakeHatchet {
  const bulkPush = vi.fn().mockResolvedValue(undefined)
  const hatchet = { events: fakeEvents(bulkPush) } as HatchetClient
  return { hatchet, bulkPush }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('startRelay: tick()', () => {
  it('pushes one bulkPush call per name and marks every row published', async () => {
    const rowA = makeRow('018f0000-0000-7000-8000-00000000000a', 'shop.order.placed')
    const rowB = makeRow('018f0000-0000-7000-8000-00000000000b', 'shop.invoice.sent')
    const { db, calls } = createFakeDb([[rowA, rowB]])
    const { hatchet, bulkPush } = createFakeHatchet()

    const relay = startRelay({ db, hatchet, workerId: 'worker-1' })
    const result = await relay.tick()
    await relay.stop()

    expect(bulkPush).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ claimed: 2, pushed: 2, failed: 0, skipped: [] })
    expect(calls.filter((call) => call.text.includes('SET published_at = now()'))).toHaveLength(2)
  })

  it('records the failure for a rejecting bulkPush and still resolves the tick', async () => {
    const rowA = makeRow('018f0000-0000-7000-8000-00000000000a', 'shop.order.placed')
    const rowB = makeRow('018f0000-0000-7000-8000-00000000000b', 'shop.invoice.sent')
    const { db, calls } = createFakeDb([[rowA, rowB]])
    const { hatchet, bulkPush } = createFakeHatchet()
    // groupEnvelopesForPush pushes names in first-seen order: shop.order.placed, then shop.invoice.sent.
    bulkPush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('engine unreachable'))

    const relay = startRelay({ db, hatchet, workerId: 'worker-1' })
    const result = await relay.tick()
    await relay.stop()

    expect(result).toEqual({ claimed: 2, pushed: 1, failed: 1, skipped: [] })
    expect(calls.some((call) => call.text.includes('attempts = attempts + 1'))).toBe(true)
  })

  it('does not overlap two ticks; stop() waits for the in-flight tick', async () => {
    const rowA = makeRow('018f0000-0000-7000-8000-00000000000a', 'shop.order.placed')
    const { db } = createFakeDb([[rowA]])
    let resolveBulkPush: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      resolveBulkPush = resolve
    })
    const bulkPush = vi.fn()
    bulkPush.mockImplementation(async () => {
      await pending
      return undefined
    })
    const hatchet = { events: fakeEvents(bulkPush) } as HatchetClient

    const relay = startRelay({ db, hatchet, workerId: 'worker-1' })
    const tickPromise = relay.tick()
    const secondTickPromise = relay.tick()

    let stopped = false
    const stopPromise = relay.stop().then(() => {
      stopped = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(stopped).toBe(false)

    resolveBulkPush?.()
    const [first, second] = await Promise.all([tickPromise, secondTickPromise])
    await stopPromise

    expect(stopped).toBe(true)
    expect(bulkPush).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
  })
})

describe('startRelay: poll loop backoff', () => {
  it('backs off after a throwing tick, doubling on repeated failures and resetting on success', async () => {
    vi.useFakeTimers()
    let attempt = 0
    const db: Queryable = {
      async query(text): Promise<QueryRows> {
        if (!text.includes('RETURNING *')) return { rows: [], rowCount: 0 }
        attempt += 1
        if (attempt <= 2) throw new Error('driver down')
        return { rows: [], rowCount: 0 }
      },
    }
    const { hatchet } = createFakeHatchet()
    const onError = vi.fn()
    const onTick = vi.fn()
    const pollIntervalMs = 1000

    const relay = startRelay({ db, hatchet, workerId: 'worker-1', pollIntervalMs, onError, onTick })

    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(pollIntervalMs * 4)
    expect(onError).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(pollIntervalMs * 8)
    expect(onTick).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(pollIntervalMs)
    expect(onTick).toHaveBeenCalledTimes(2)

    await relay.stop()
  })
})
