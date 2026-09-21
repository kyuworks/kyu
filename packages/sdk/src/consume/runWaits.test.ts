import { describe, expect, it } from 'vitest'
import { KyuError } from '../hatchet.js'
import { readRunWait, toAnyWaitLabel, toWaitLabel } from './runWaits.js'
import type { DurableLogReader } from './runWaits.js'

type Entry = Awaited<ReturnType<DurableLogReader['api']['v1DurableTaskEventLogList']>>['data'][number]
type LogQuery = Parameters<DurableLogReader['api']['v1DurableTaskEventLogList']>[2]

// Slices `allEntries` by the `offset`/`limit` the production code sends, the
// same way the real engine paginates, so a fixture with more than one page's
// worth of entries exercises the paging loop without a bespoke mock per test.
function fakeReader(allEntries: Entry[], error?: Error): DurableLogReader {
  return {
    tenantId: 'tenant-1',
    api: {
      v1DurableTaskEventLogList: async (_tenantId: string, _runId: string, query?: LogQuery) => {
        if (error !== undefined) throw error
        const offset = query?.offset ?? 0
        const limit = query?.limit ?? allEntries.length
        return { data: allEntries.slice(offset, offset + limit) } as Awaited<
          ReturnType<DurableLogReader['api']['v1DurableTaskEventLogList']>
        >
      },
    },
  }
}

// `Entry['kind']`/`Entry['waitData'][number]['kind']` are declared enums,
// nominal to TypeScript: a plain string literal is not assignable to them
// even structurally, so overrides take the literal spelling here and `entry`
// casts once — the same pattern `fixtureRow` uses in runOutcomes.test.ts.
interface WaitConditionOverride {
  kind?: 'SLEEP' | 'USER_EVENT' | 'CHILD_WORKFLOW'
  sleepDurationMs?: number
  eventKey?: string
  or?: WaitConditionOverride[]
}

interface EntryOverrides {
  nodeId?: number
  kind?: 'RUN' | 'WAIT_FOR' | 'MEMO'
  isSatisfied?: boolean
  insertedAt?: string
  userMessage?: string
  waitData?: WaitConditionOverride[]
}

function entry(overrides: EntryOverrides): Entry {
  return {
    nodeId: 1,
    branchId: 1,
    kind: 'WAIT_FOR',
    isSatisfied: false,
    insertedAt: '2026-01-01T00:00:00.000Z',
    taskExternalId: 'run-1',
    taskDisplayName: 'run-1',
    ...overrides,
  } as Entry
}

describe('readRunWait', () => {
  it('a parked waitFor reports the message name and the field match from its label', async () => {
    const reader = fakeReader([
      entry({
        userMessage: toWaitLabel({ field: 'data.orderId', equals: 'ord-1' }),
        waitData: [
          {
            or: [
              { kind: 'SLEEP', sleepDurationMs: 120_000 },
              { kind: 'USER_EVENT', eventKey: 'ns_shop.order.shipped' },
            ],
          },
        ],
      }),
    ])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toEqual({
      kind: 'message',
      name: 'shop.order.shipped',
      match: { field: 'data.orderId', equals: 'ord-1' },
    })
  })

  it('a parked sleepFor reports the wake time as insertedAt plus the duration', async () => {
    const reader = fakeReader([entry({ waitData: [{ kind: 'SLEEP', sleepDurationMs: 600_000 }] })])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toEqual({
      kind: 'sleep',
      until: new Date('2026-01-01T00:10:00.000Z'),
    })
  })

  it('takes the unsatisfied WAIT_FOR entry with the greatest nodeId and ignores satisfied ones and MEMO entries', async () => {
    const reader = fakeReader([
      entry({
        nodeId: 1,
        isSatisfied: true,
        insertedAt: '2026-01-01T00:00:00.000Z',
        waitData: [{ kind: 'SLEEP', sleepDurationMs: 30_000 }],
      }),
      entry({ nodeId: 2, kind: 'MEMO', isSatisfied: true, insertedAt: '2026-01-01T00:00:10.000Z' }),
      entry({
        nodeId: 3,
        isSatisfied: false,
        insertedAt: '2026-01-01T00:00:00.000Z',
        waitData: [{ kind: 'SLEEP', sleepDurationMs: 60_000 }],
      }),
    ])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toEqual({
      kind: 'sleep',
      until: new Date('2026-01-01T00:01:00.000Z'),
    })
  })

  it('an empty log — a plain, non-durable run — reports no wait', async () => {
    const reader = fakeReader([])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toBeUndefined()
  })

  it('a log whose entries are all satisfied reports no wait', async () => {
    const reader = fakeReader([entry({ isSatisfied: true, waitData: [{ kind: 'SLEEP', sleepDurationMs: 60_000 }] })])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toBeUndefined()
  })

  it('an unlabelled USER_EVENT wait — parked by a worker on an older SDK — reports the name with no match', async () => {
    const reader = fakeReader([entry({ waitData: [{ kind: 'USER_EVENT', eventKey: 'ns_shop.order.shipped' }] })])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toEqual({
      kind: 'message',
      name: 'shop.order.shipped',
    })
  })

  it('a USER_EVENT wait carrying a label this SDK did not write reports the name with no match', async () => {
    const reader = fakeReader([
      entry({
        userMessage: 'something else',
        waitData: [{ kind: 'USER_EVENT', eventKey: 'ns_shop.order.shipped' }],
      }),
    ])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toEqual({
      kind: 'message',
      name: 'shop.order.shipped',
    })
  })

  it('wraps a rejected engine call in KyuError with the original error as cause', async () => {
    const cause = new Error('engine unreachable')
    const reader = fakeReader([], cause)
    expect.assertions(2)
    try {
      await readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')
    } catch (error) {
      expect(error).toBeInstanceOf(KyuError)
      expect(error).toHaveProperty('cause', cause)
    }
  })

  it('a log that exactly fills one page but has no more entries does not throw', async () => {
    const entries = Array.from({ length: 500 }, (_, i) => entry({ nodeId: i + 1, isSatisfied: true }))
    const reader = fakeReader(entries)
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toBeUndefined()
  })

  it('reads a second page when the first comes back full, and finds the wait it holds', async () => {
    const firstPage = Array.from({ length: 500 }, (_, i) => entry({ nodeId: i + 1, isSatisfied: true }))
    const secondPage = [
      entry({ nodeId: 501, isSatisfied: false, waitData: [{ kind: 'SLEEP', sleepDurationMs: 60_000 }] }),
    ]
    const reader = fakeReader([...firstPage, ...secondPage])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toEqual({
      kind: 'sleep',
      until: new Date('2026-01-01T00:01:00.000Z'),
    })
  })

  it('throws KyuError once the durable log would need an 11th page (beyond the 5000-entry ceiling)', async () => {
    const entries = Array.from({ length: 5000 }, (_, i) => entry({ nodeId: i + 1, isSatisfied: true }))
    const reader = fakeReader(entries)
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).rejects.toBeInstanceOf(KyuError)
  })

  it('a wait on several names reports every name and its match from the label', async () => {
    const reader = fakeReader([
      entry({
        userMessage: toAnyWaitLabel([
          { name: 'shop.order.shipped', field: 'data.orderId', equals: 'ord-1' },
          { name: 'shop.order.cancelled', field: 'data.orderId', equals: 'ord-1' },
        ]),
        waitData: [
          {
            or: [
              { kind: 'SLEEP', sleepDurationMs: 30_000 },
              { kind: 'USER_EVENT', eventKey: 'ns_shop.order.shipped' },
              { kind: 'USER_EVENT', eventKey: 'ns_shop.order.cancelled' },
            ],
          },
        ],
      }),
    ])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toEqual({
      kind: 'anyMessage',
      waits: [
        { name: 'shop.order.shipped', match: { field: 'data.orderId', equals: 'ord-1' } },
        { name: 'shop.order.cancelled', match: { field: 'data.orderId', equals: 'ord-1' } },
      ],
    })
  })

  it('a wait on several names with no decodable label reports the names alone', async () => {
    const reader = fakeReader([
      entry({
        waitData: [
          {
            or: [
              { kind: 'SLEEP', sleepDurationMs: 30_000 },
              { kind: 'USER_EVENT', eventKey: 'ns_shop.order.shipped' },
              { kind: 'USER_EVENT', eventKey: 'ns_shop.order.cancelled' },
            ],
          },
        ],
      }),
    ])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toEqual({
      kind: 'anyMessage',
      waits: [{ name: 'shop.order.shipped' }, { name: 'shop.order.cancelled' }],
    })
  })

  it('a waitForChildren fan-out park — one Or group per child, same reply name, no label — reads as a single message wait, not anyMessage', async () => {
    const reader = fakeReader([
      entry({
        waitData: [
          {
            or: [
              { kind: 'USER_EVENT', eventKey: 'ns_shop.order.fanout_replied' },
              { kind: 'SLEEP', sleepDurationMs: 30_000 },
            ],
          },
          {
            or: [
              { kind: 'USER_EVENT', eventKey: 'ns_shop.order.fanout_replied' },
              { kind: 'SLEEP', sleepDurationMs: 30_000 },
            ],
          },
        ],
      }),
    ])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toEqual({
      kind: 'message',
      name: 'shop.order.fanout_replied',
    })
  })

  it('an anyWaitLabel whose entry count disagrees with the USER_EVENT conditions falls back to the condition names, not the label', async () => {
    const reader = fakeReader([
      entry({
        userMessage: toAnyWaitLabel([{ name: 'shop.order.shipped', field: 'data.orderId', equals: 'ord-1' }]),
        waitData: [
          {
            or: [
              { kind: 'SLEEP', sleepDurationMs: 30_000 },
              { kind: 'USER_EVENT', eventKey: 'ns_shop.order.shipped' },
              { kind: 'USER_EVENT', eventKey: 'ns_shop.order.cancelled' },
            ],
          },
        ],
      }),
    ])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toEqual({
      kind: 'anyMessage',
      waits: [{ name: 'shop.order.shipped' }, { name: 'shop.order.cancelled' }],
    })
  })

  it('a wait on several names with an undecodable kyu:2 label falls back to the condition names', async () => {
    const reader = fakeReader([
      entry({
        userMessage: 'kyu:2:not json',
        waitData: [
          {
            or: [
              { kind: 'SLEEP', sleepDurationMs: 30_000 },
              { kind: 'USER_EVENT', eventKey: 'ns_shop.order.shipped' },
              { kind: 'USER_EVENT', eventKey: 'ns_shop.order.cancelled' },
            ],
          },
        ],
      }),
    ])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toEqual({
      kind: 'anyMessage',
      waits: [{ name: 'shop.order.shipped' }, { name: 'shop.order.cancelled' }],
    })
  })
})
