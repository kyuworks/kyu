import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { QueryParam, Queryable, QueryRows } from '../db/queryable.js'
import { RelayConnectionLostError } from '../errors.js'
import type { HatchetClient } from '../hatchet.js'
import { outboxRowSchema } from '../outbox/rows.js'
import type { OutboxRow } from '../outbox/rows.js'
import { startRelay } from './relay.js'
import type { PushItem } from './toEvents.js'

interface FakeBulkPushResponse {
  events: object[]
}

// `HatchetClient['events']['bulkPush']`'s own signature is generic over `T`; a
// concrete procedure type keeps every mock's `mockImplementation*` call checked.
type BulkPushProcedure = (name: string, items: PushItem[]) => Promise<FakeBulkPushResponse>

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
function fakeEvents(bulkPush: Mock<BulkPushProcedure>): HatchetClient['events'] {
  return { bulkPush: bulkPush as HatchetClient['events']['bulkPush'] } as HatchetClient['events']
}

interface FakeHatchet {
  hatchet: HatchetClient
  bulkPush: Mock<BulkPushProcedure>
}

// Echoes one event per input by default, matching the real `bulkPush` response shape.
function createFakeHatchet(): FakeHatchet {
  const bulkPush = vi.fn<BulkPushProcedure>(async (_name, items) => ({ events: items.map(() => ({})) }))
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
    expect(result).toEqual({ claimed: 2, pushed: 2, failed: 0, skipped: [], failedIds: [] })
    expect(calls.filter((call) => call.text.includes('SET published_at = now()'))).toHaveLength(2)
  })

  it('records the failure for a rejecting bulkPush and still resolves the tick', async () => {
    const rowA = makeRow('018f0000-0000-7000-8000-00000000000a', 'shop.order.placed')
    const rowB = makeRow('018f0000-0000-7000-8000-00000000000b', 'shop.invoice.sent')
    const { db, calls } = createFakeDb([[rowA, rowB]])
    const { hatchet, bulkPush } = createFakeHatchet()
    // groupEnvelopesForPush pushes names in first-seen order: shop.order.placed, then shop.invoice.sent.
    bulkPush
      .mockImplementationOnce(async (_name, items) => ({ events: items.map(() => ({})) }))
      .mockRejectedValueOnce(new Error('engine unreachable'))

    const relay = startRelay({ db, hatchet, workerId: 'worker-1' })
    const result = await relay.tick()
    await relay.stop()

    expect(result).toEqual({ claimed: 2, pushed: 1, failed: 1, skipped: [], failedIds: [rowB.id] })
    expect(calls.some((call) => call.text.includes('attempts = attempts + 1'))).toBe(true)
  })

  it('does not overlap two ticks; stop() waits for the in-flight tick', async () => {
    const rowA = makeRow('018f0000-0000-7000-8000-00000000000a', 'shop.order.placed')
    const { db } = createFakeDb([[rowA]])
    let resolveBulkPush: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      resolveBulkPush = resolve
    })
    const bulkPush = vi.fn<BulkPushProcedure>()
    bulkPush.mockImplementation(async (_name, items) => {
      await pending
      return { events: items.map(() => ({})) }
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

  it('rejects tick() called after stop()', async () => {
    const { db } = createFakeDb([[]])
    const { hatchet } = createFakeHatchet()

    const relay = startRelay({ db, hatchet, workerId: 'worker-1' })
    await relay.stop()

    await expect(relay.tick()).rejects.toThrow('relay is stopped')
  })
})

describe('startRelay: callback safety', () => {
  it('keeps polling and leaks no unhandled rejection when onError itself throws', async () => {
    vi.useFakeTimers()
    // Every claim query rejects, so every tick fails and onError fires each time.
    const db: Queryable = {
      async query(text): Promise<QueryRows> {
        if (!text.includes('RETURNING *')) return { rows: [], rowCount: 0 }
        throw new Error('driver down')
      },
    }
    const { hatchet } = createFakeHatchet()
    const onError = vi.fn(() => {
      throw new Error('onError itself throws')
    })
    const pollIntervalMs = 1000

    const unhandled: unknown[] = []
    const recordUnhandled: NodeJS.UnhandledRejectionListener = (reason) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', recordUnhandled)

    try {
      const relay = startRelay({ db, hatchet, workerId: 'worker-1', pollIntervalMs, onError })

      await vi.advanceTimersByTimeAsync(0)
      expect(onError).toHaveBeenCalledTimes(1) // backoff now 4000

      await vi.advanceTimersByTimeAsync(pollIntervalMs * 4)
      expect(onError).toHaveBeenCalledTimes(2) // backoff now 8000

      await vi.advanceTimersByTimeAsync(pollIntervalMs * 8)
      expect(onError).toHaveBeenCalledTimes(3) // backoff now 16000

      await relay.stop()
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      process.off('unhandledRejection', recordUnhandled)
    }

    expect(unhandled).toEqual([])
  })

  it('does not report a throwing onTick to onError as a push failure, and keeps polling', async () => {
    vi.useFakeTimers()
    const { db } = createFakeDb([[], []])
    const { hatchet } = createFakeHatchet()
    const onError = vi.fn()
    const onTick = vi.fn(() => {
      throw new Error('onTick blew up')
    })
    const pollIntervalMs = 1000

    const relay = startRelay({ db, hatchet, workerId: 'worker-1', pollIntervalMs, onTick, onError })

    await vi.advanceTimersByTimeAsync(0)
    expect(onTick).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()

    // The loop still schedules the next tick despite onTick's throw.
    await vi.advanceTimersByTimeAsync(pollIntervalMs)
    expect(onTick).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()

    await relay.stop()
  })
})

describe('startRelay: dead database handle', () => {
  it('keeps polling through a transient database error, then stops itself when the handle is permanently dead', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const db: Queryable = {
      async query(text): Promise<QueryRows> {
        if (!text.includes('RETURNING *')) return { rows: [], rowCount: 0 }
        attempts += 1
        if (attempts === 1) throw new Error('driver down')
        if (attempts === 2) return { rows: [], rowCount: 0 }
        throw new Error('Client has encountered a connection error and is not queryable')
      },
    }
    const { hatchet } = createFakeHatchet()
    const onError = vi.fn()
    const onTick = vi.fn()
    const pollIntervalMs = 1000

    const relay = startRelay({ db, hatchet, workerId: 'worker-1', pollIntervalMs, onError, onTick })

    // attempt 1: transient failure, backs off.
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onTick).toHaveBeenCalledTimes(0)

    // attempt 2: succeeds (empty claim), resets backoff, schedules the next tick after pollIntervalMs.
    await vi.advanceTimersByTimeAsync(pollIntervalMs * 4)
    expect(onTick).toHaveBeenCalledTimes(1)

    // attempt 3: the handle is permanently dead. The relay stops itself.
    await vi.advanceTimersByTimeAsync(pollIntervalMs)
    expect(attempts).toBe(3)
    expect(onError).toHaveBeenCalledTimes(2)
    const lastError = onError.mock.calls[1]?.[0] as Error
    expect(lastError).toBeInstanceOf(RelayConnectionLostError)
    expect(lastError.message).toContain('connection')

    // No further claim attempts, however long the clock advances.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(attempts).toBe(3)

    await expect(relay.closed).rejects.toBeInstanceOf(RelayConnectionLostError)
    await expect(relay.tick()).rejects.toThrow('relay is stopped')
  })

  it('also stops on the pool-closed marker', async () => {
    const db: Queryable = {
      async query(text): Promise<QueryRows> {
        if (!text.includes('RETURNING *')) return { rows: [], rowCount: 0 }
        throw new Error('Cannot use a pool after calling end on the pool')
      },
    }
    const relay = startRelay({ db, hatchet: createFakeHatchet().hatchet, workerId: 'worker-1' })
    await expect(relay.closed).rejects.toBeInstanceOf(RelayConnectionLostError)
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

describe('startRelay: poll loop scheduling', () => {
  it('re-ticks at 0 ms only after a full, fully-pushed batch', async () => {
    vi.useFakeTimers()
    // Only one batch is provided; every claim after it returns no rows (partial).
    const rowA = makeRow('018f0000-0000-7000-8000-00000000000a', 'shop.relay.a')
    const { db } = createFakeDb([[rowA]])
    const { hatchet } = createFakeHatchet()
    const onTick = vi.fn()
    const pollIntervalMs = 1000

    const relay = startRelay({ db, hatchet, workerId: 'worker-1', batchSize: 1, pollIntervalMs, onTick })

    // tick1 claims a full batch (1 row, batchSize 1) and pushes it fully.
    await vi.advanceTimersByTimeAsync(0)
    expect(onTick).toHaveBeenCalledTimes(1)

    // It re-ticks immediately (0 ms), not after pollIntervalMs: tick2 (an
    // empty, partial claim) is already reachable well before the interval.
    await vi.advanceTimersByTimeAsync(1)
    expect(onTick).toHaveBeenCalledTimes(2)

    // tick2 was partial, so tick3 waits for the full poll interval, not 0 ms.
    await vi.advanceTimersByTimeAsync(pollIntervalMs - 1)
    expect(onTick).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(onTick).toHaveBeenCalledTimes(3)

    await relay.stop()
  })

  it('waits a full pollIntervalMs after a partial batch', async () => {
    vi.useFakeTimers()
    const rowA = makeRow('018f0000-0000-7000-8000-00000000000a', 'shop.relay.a')
    const { db } = createFakeDb([[rowA]])
    const { hatchet } = createFakeHatchet()
    const onTick = vi.fn()
    const pollIntervalMs = 1000

    // batchSize 5 makes the one-row claim partial.
    const relay = startRelay({ db, hatchet, workerId: 'worker-1', batchSize: 5, pollIntervalMs, onTick })

    await vi.advanceTimersByTimeAsync(0)
    expect(onTick).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(pollIntervalMs - 1)
    expect(onTick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(onTick).toHaveBeenCalledTimes(2)

    await relay.stop()
  })

  it('a tick with failed > 0 backs off and calls onError instead of re-ticking immediately', async () => {
    vi.useFakeTimers()
    const rowA = makeRow('018f0000-0000-7000-8000-00000000000a', 'shop.relay.a')
    const { db } = createFakeDb([[rowA], [rowA]])
    const bulkPush = vi
      .fn<BulkPushProcedure>()
      .mockRejectedValueOnce(new Error('engine unreachable'))
      .mockImplementation(async (_name, items) => ({ events: items.map(() => ({})) }))
    const hatchet = { events: fakeEvents(bulkPush) } as HatchetClient
    const onError = vi.fn()
    const onTick = vi.fn()
    const pollIntervalMs = 1000

    // batchSize 1 makes every claim here full, so the pre-fix loop would
    // re-tick at 0 ms regardless of the push failure.
    const relay = startRelay({ db, hatchet, workerId: 'worker-1', batchSize: 1, pollIntervalMs, onError, onTick })

    await vi.advanceTimersByTimeAsync(0)
    expect(bulkPush).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    // A failed tick is not a "success", so onTick does not fire for it.
    expect(onTick).toHaveBeenCalledTimes(0)

    await vi.advanceTimersByTimeAsync(pollIntervalMs * 4 - 1)
    expect(bulkPush).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(bulkPush).toHaveBeenCalledTimes(2)

    await relay.stop()
  })

  it('doubles the backoff on consecutive failed ticks up to the 30 s cap, and a success resets it', async () => {
    vi.useFakeTimers()
    const rowA = makeRow('018f0000-0000-7000-8000-00000000000a', 'shop.relay.a')
    const { db } = createFakeDb([[rowA], [rowA], [rowA], [rowA], []])
    const bulkPush = vi
      .fn<BulkPushProcedure>()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockRejectedValueOnce(new Error('e3'))
      .mockRejectedValueOnce(new Error('e4'))
    const hatchet = { events: fakeEvents(bulkPush) } as HatchetClient
    const onError = vi.fn()
    const onTick = vi.fn()
    const pollIntervalMs = 1000

    const relay = startRelay({ db, hatchet, workerId: 'worker-1', batchSize: 1, pollIntervalMs, onError, onTick })

    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1) // backoff now 4000 (pollIntervalMs * 4)

    await vi.advanceTimersByTimeAsync(pollIntervalMs * 4)
    expect(onError).toHaveBeenCalledTimes(2) // backoff now 8000

    await vi.advanceTimersByTimeAsync(pollIntervalMs * 8)
    expect(onError).toHaveBeenCalledTimes(3) // backoff now 16000

    await vi.advanceTimersByTimeAsync(pollIntervalMs * 16)
    expect(onError).toHaveBeenCalledTimes(4) // 16000 * 2 = 32000, capped at 30000

    // The 5th claim is empty (a fully-successful, if partial, tick): it resets the backoff.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onTick).toHaveBeenCalledTimes(1)
    expect(onTick.mock.calls[0]?.[0]).toMatchObject({ failed: 0 })

    await relay.stop()
  })
})

describe('startRelay: claim release on a mid-batch mark failure', () => {
  it('releases the unprocessed groups’ claims when markPublished throws, and the tick still rejects', async () => {
    const rowA = makeRow('018f0000-0000-7000-8000-00000000000a', 'shop.relay.a')
    const rowB = makeRow('018f0000-0000-7000-8000-00000000000b', 'shop.relay.b')
    const calls: RecordedQuery[] = []
    let markAttempts = 0
    const db: Queryable = {
      async query(text, params): Promise<QueryRows> {
        calls.push({ text, params })
        if (text.includes('RETURNING *')) return { rows: [rowA, rowB], rowCount: 2 }
        if (text.includes('SET published_at = now()')) {
          markAttempts += 1
          if (markAttempts === 1) throw new Error('simulated crash before mark')
          return { rows: [], rowCount: 0 }
        }
        return { rows: [], rowCount: 0 }
      },
    }
    const { hatchet } = createFakeHatchet()

    const relay = startRelay({ db, hatchet, workerId: 'worker-1', pollIntervalMs: 60_000 })
    await expect(relay.tick()).rejects.toThrow('simulated crash before mark')
    await relay.stop()

    // releaseClaims's own UPDATE: single-line, `$1` holds the id array — distinct
    // from recordPublishFailure's multi-line UPDATE, which places the ids at `$2`.
    const releaseCall = calls.find((call) =>
      call.text.includes('claimed_at = NULL, claimed_by = NULL WHERE id = ANY($1::uuid[])'),
    )
    expect(releaseCall).toBeDefined()
    const releasedIds = String(releaseCall?.params[0])
    expect(releasedIds).toContain(rowA.id)
    expect(releasedIds).toContain(rowB.id)
  })
})

describe('startRelay: tick() mutation guards', () => {
  it('fails the whole group on a short bulkPush response: no publish, both ids marked failed', async () => {
    const rowA = makeRow('018f0000-0000-7000-8000-00000000000a', 'shop.order.placed')
    const rowB = makeRow('018f0000-0000-7000-8000-00000000000b', 'shop.order.placed')
    const { db, calls } = createFakeDb([[rowA, rowB]])
    // Echoes one event instead of the two sent — the engine's own partial-accept shape.
    const bulkPush = vi.fn<BulkPushProcedure>(async (_name, items) => ({ events: items.slice(0, 1).map(() => ({})) }))
    const hatchet = { events: fakeEvents(bulkPush) } as HatchetClient

    const relay = startRelay({ db, hatchet, workerId: 'worker-1' })
    const result = await relay.tick()
    await relay.stop()

    expect(result.pushed).toBe(0)
    expect(result.failed).toBe(2)
    expect([...result.failedIds].sort()).toEqual([rowA.id, rowB.id].sort())
    expect(calls.some((call) => call.text.includes('SET published_at = now()'))).toBe(false)
  })

  it('truncates a long failure message to 1000 characters before storing it', async () => {
    const rowA = makeRow('018f0000-0000-7000-8000-00000000000a', 'shop.order.placed')
    const { db, calls } = createFakeDb([[rowA]])
    const bulkPush = vi.fn<BulkPushProcedure>().mockRejectedValueOnce(new Error('x'.repeat(50_000)))
    const hatchet = { events: fakeEvents(bulkPush) } as HatchetClient

    const relay = startRelay({ db, hatchet, workerId: 'worker-1' })
    await relay.tick()
    await relay.stop()

    const failureCall = calls.find((call) => call.text.includes('attempts = attempts + 1'))
    const storedMessage = String(failureCall?.params[0])
    expect(storedMessage).toHaveLength(1000)
  })

  it('passes a custom staleClaimMs through to the claim query', async () => {
    const { db, calls } = createFakeDb([[]])
    const { hatchet } = createFakeHatchet()

    const relay = startRelay({ db, hatchet, workerId: 'worker-1', staleClaimMs: 1234 })
    await relay.tick()
    await relay.stop()

    const claimCall = calls.find((call) => call.text.includes('RETURNING *'))
    expect(claimCall?.params).toContain(1234)
  })

  it('stores a non-Error rejection as its rendered JSON, not the bare value', async () => {
    const rowA = makeRow('018f0000-0000-7000-8000-00000000000a', 'shop.order.placed')
    const { db, calls } = createFakeDb([[rowA]])
    const bulkPush = vi.fn<BulkPushProcedure>().mockRejectedValueOnce('boom')
    const hatchet = { events: fakeEvents(bulkPush) } as HatchetClient

    const relay = startRelay({ db, hatchet, workerId: 'worker-1' })
    await relay.tick()
    await relay.stop()

    const failureCall = calls.find((call) => call.text.includes('attempts = attempts + 1'))
    expect(failureCall?.params[0]).toBe('"boom"')
  })

  it('resets the backoff after a successful tick, so the next failure backs off at the base delay again', async () => {
    vi.useFakeTimers()
    const rowA = makeRow('018f0000-0000-7000-8000-00000000000a', 'shop.relay.a')
    const { db } = createFakeDb([[rowA], [], [rowA]])
    const bulkPush = vi
      .fn<BulkPushProcedure>()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
    const hatchet = { events: fakeEvents(bulkPush) } as HatchetClient
    const onError = vi.fn()
    const onTick = vi.fn()
    const pollIntervalMs = 1000

    const relay = startRelay({ db, hatchet, workerId: 'worker-1', pollIntervalMs, onError, onTick })

    // tick1 fails at t=0: backoff becomes the base 4x (4000).
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1)

    // tick2, after the base backoff, claims nothing and succeeds: resets backoff to 0.
    await vi.advanceTimersByTimeAsync(pollIntervalMs * 4)
    expect(onTick).toHaveBeenCalledTimes(1)

    // tick3, after the plain poll interval, fails again.
    await vi.advanceTimersByTimeAsync(pollIntervalMs)
    expect(onError).toHaveBeenCalledTimes(2)

    // Without the reset, this failure would double the old 4000 backoff to
    // 8000; confirm the next tick fires at the base 4000 instead.
    await vi.advanceTimersByTimeAsync(pollIntervalMs * 4 - 1)
    expect(onTick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(onTick).toHaveBeenCalledTimes(2)

    await relay.stop()
  })
})
