import { describe, expect, it } from 'vitest'
import { KyuError } from '../hatchet.js'
import { readRunWait, toWaitLabel } from './runWaits.js'
import type { DurableLogReader } from './runWaits.js'

type Entry = Awaited<ReturnType<DurableLogReader['api']['v1DurableTaskEventLogList']>>['data'][number]

function fakeReader(entries: Entry[], error?: Error): DurableLogReader {
  return {
    tenantId: 'tenant-1',
    api: {
      v1DurableTaskEventLogList: async () => {
        if (error !== undefined) throw error
        return { data: entries } as Awaited<ReturnType<DurableLogReader['api']['v1DurableTaskEventLogList']>>
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
  it('a parked waitFor reports the message name, field and value from its label', async () => {
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
      field: 'data.orderId',
      equals: 'ord-1',
    })
  })

  it('a parked sleepFor reports the wake time as insertedAt plus the duration', async () => {
    const reader = fakeReader([entry({ waitData: [{ kind: 'SLEEP', sleepDurationMs: 600_000 }] })])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).resolves.toEqual({
      kind: 'sleep',
      until: new Date('2026-01-01T00:10:00.000Z'),
    })
  })

  it('takes the last unsatisfied WAIT_FOR entry and ignores satisfied ones and MEMO entries', async () => {
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

  it('throws KyuError when a message wait carries no label', async () => {
    const reader = fakeReader([entry({ waitData: [{ kind: 'USER_EVENT', eventKey: 'ns_shop.order.shipped' }] })])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).rejects.toBeInstanceOf(KyuError)
  })

  it('throws KyuError when a message wait carries a label this SDK did not write', async () => {
    const reader = fakeReader([
      entry({
        userMessage: 'something else',
        waitData: [{ kind: 'USER_EVENT', eventKey: 'ns_shop.order.shipped' }],
      }),
    ])
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).rejects.toBeInstanceOf(KyuError)
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

  it('throws KyuError when the log fills a whole page', async () => {
    const entries = Array.from({ length: 500 }, (_, i) => entry({ nodeId: i + 1, isSatisfied: true }))
    const reader = fakeReader(entries)
    await expect(readRunWait(reader, 'run-1', 'ns_', 'runs.forCorrelation')).rejects.toBeInstanceOf(KyuError)
  })
})
