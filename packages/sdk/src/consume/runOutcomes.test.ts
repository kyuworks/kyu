import { uuidv7 } from '@kyuworks/schemas'
import { describe, expect, it } from 'vitest'
import { KyuError } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import { readRunOutcomes, toRunOutcome } from './runOutcomes.js'
import type { RunsReader } from './runOutcomes.js'

type EngineRunRow = Awaited<ReturnType<HatchetClient['runs']['list']>>['rows'][number]

// The engine's `status`/`type` fields are declared enums, nominal to
// TypeScript: a plain string literal can be compared against them but not
// assigned, so `status`/`type` here take the literal spelling and `fixtureRow`
// casts once. `workflowName`, `startedAt` and `finishedAt` take `| undefined`
// explicitly (`exactOptionalPropertyTypes`) so a case can ask for the key to
// be genuinely absent, not merely defaulted.
interface RowOverrides {
  status?: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'FAILED'
  retryCount?: number
  attempt?: number
  errorMessage?: string
  workflowName?: string | undefined
  taskExternalId?: string
  startedAt?: string | undefined
  finishedAt?: string | undefined
}

// Fills every field the engine's contract requires once; each case overrides
// only what it needs to vary. `workflowName`/`startedAt`/`finishedAt` default
// to present; passing `undefined` for one removes the key with `delete`,
// never an explicit `= undefined` assignment (exactOptionalPropertyTypes).
function fixtureRow(overrides: RowOverrides = {}): EngineRunRow {
  const row: EngineRunRow = {
    metadata: {
      id: '018f0000-0000-7000-8000-000000000001',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    displayName: 'sample-run-1789724676681',
    input: {},
    numSpawnedChildren: 0,
    output: {},
    status: (overrides.status ?? 'COMPLETED') as EngineRunRow['status'],
    taskExternalId: overrides.taskExternalId ?? '018f0000-0000-7000-8000-000000000002',
    taskId: 1,
    taskInsertedAt: '2026-01-01T00:00:00.000Z',
    tenantId: '018f0000-0000-7000-8000-000000000003',
    type: 'TASK' as EngineRunRow['type'],
    workflowId: '018f0000-0000-7000-8000-000000000004',
    workflowRunExternalId: '018f0000-0000-7000-8000-000000000005',
    workflowName: 'ns_sample-run',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
  }

  if ('workflowName' in overrides) {
    const { workflowName } = overrides
    if (workflowName === undefined) delete row.workflowName
    else row.workflowName = workflowName
  }
  if ('startedAt' in overrides) {
    const { startedAt } = overrides
    if (startedAt === undefined) delete row.startedAt
    else row.startedAt = startedAt
  }
  if ('finishedAt' in overrides) {
    const { finishedAt } = overrides
    if (finishedAt === undefined) delete row.finishedAt
    else row.finishedAt = finishedAt
  }
  if (overrides.retryCount !== undefined) row.retryCount = overrides.retryCount
  if (overrides.attempt !== undefined) row.attempt = overrides.attempt
  if (overrides.errorMessage !== undefined) row.errorMessage = overrides.errorMessage

  return row
}

describe('toRunOutcome', () => {
  it.each([
    ['QUEUED', 'queued'],
    ['RUNNING', 'running'],
    ['COMPLETED', 'completed'],
    ['CANCELLED', 'cancelled'],
    ['FAILED', 'failed'],
  ] as const)('maps %s to %s', (engineStatus, expected) => {
    const row = fixtureRow({ status: engineStatus })
    expect(toRunOutcome(row, 'ns_')?.status).toBe(expected)
  })

  // Named red proof: watch this fail on the assertion (not on a missing
  // import) before `toRunOutcome`'s mapping body exists.
  it('maps a FAILED engine row to failed with attempts 1 and the error message', () => {
    const row = fixtureRow({ status: 'FAILED', retryCount: 0, errorMessage: 'no such invoice' })
    expect(toRunOutcome(row, 'ns_')).toEqual(
      expect.objectContaining({ status: 'failed', attempts: 1, error: 'no such invoice' }),
    )
  })

  it('retryCount 0 gives attempts 1', () => {
    const row = fixtureRow({ retryCount: 0 })
    expect(toRunOutcome(row, 'ns_')?.attempts).toBe(1)
  })

  it('an absent retryCount gives attempts 1', () => {
    const row = fixtureRow()
    expect(toRunOutcome(row, 'ns_')?.attempts).toBe(1)
  })

  it('uses the engine’s own attempt when present, ignoring retryCount', () => {
    const row = fixtureRow({ attempt: 4, retryCount: 0 })
    expect(toRunOutcome(row, 'ns_')?.attempts).toBe(4)
  })

  it('falls back to retryCount + 1 when attempt is absent', () => {
    const row = fixtureRow({ retryCount: 2 })
    expect(toRunOutcome(row, 'ns_')?.attempts).toBe(3)
  })

  it('strips the namespace prefix off workflowName to get the subscription name', () => {
    const row = fixtureRow({ workflowName: 'ns_record-order' })
    expect(toRunOutcome(row, 'ns_')?.subscription).toBe('record-order')
  })

  it('excludes a row from another namespace', () => {
    const row = fixtureRow({ workflowName: 'other_record-order' })
    expect(toRunOutcome(row, 'ns_')).toBeUndefined()
  })

  // Pinning current behaviour, not endorsing it: the prefix check alone
  // cannot tell a sibling namespace from this one. One Hatchet tenant per
  // project per environment is what keeps this from happening in production.
  it('does not filter out a sibling namespace that extends this one as a prefix', () => {
    const row = fixtureRow({ workflowName: 'shop_staging_record-order' })
    expect(toRunOutcome(row, 'shop_')?.subscription).toBe('staging_record-order')
  })

  it('excludes a row with no workflowName', () => {
    const row = fixtureRow({ workflowName: undefined })
    expect(toRunOutcome(row, 'ns_')).toBeUndefined()
  })

  it('an empty namespace keeps the whole workflowName as the subscription', () => {
    const row = fixtureRow({ workflowName: 'record-order' })
    expect(toRunOutcome(row, '')?.subscription).toBe('record-order')
  })

  it('an empty errorMessage leaves error absent', () => {
    const row = fixtureRow({ errorMessage: '' })
    const outcome = toRunOutcome(row, 'ns_')
    expect(outcome).toBeDefined()
    expect('error' in (outcome ?? {})).toBe(false)
  })

  it('a non-empty errorMessage on a FAILED row becomes error', () => {
    const row = fixtureRow({ status: 'FAILED', errorMessage: 'boom' })
    expect(toRunOutcome(row, 'ns_')?.error).toBe('boom')
  })

  it('a queued row with no startedAt/finishedAt leaves those keys absent, and createdAt is a Date', () => {
    const row = fixtureRow({ status: 'QUEUED', startedAt: undefined, finishedAt: undefined })
    const outcome = toRunOutcome(row, 'ns_')
    expect(outcome).toBeDefined()
    expect('startedAt' in (outcome ?? {})).toBe(false)
    expect('finishedAt' in (outcome ?? {})).toBe(false)
    expect(outcome?.createdAt).toBeInstanceOf(Date)
  })

  it('carries the run id from taskExternalId', () => {
    const row = fixtureRow({ taskExternalId: '018f0000-0000-7000-8000-0000000000ff' })
    expect(toRunOutcome(row, 'ns_')?.runId).toBe('018f0000-0000-7000-8000-0000000000ff')
  })

  // The engine writes the terminal status before it writes the timestamps,
  // so a row caught in that gap must not report a terminal outcome a
  // consumer would treat as settled.
  it('a COMPLETED row missing finishedAt reads running, with finishedAt absent', () => {
    const row = fixtureRow({ status: 'COMPLETED', finishedAt: undefined })
    const outcome = toRunOutcome(row, 'ns_')
    expect(outcome?.status).toBe('running')
    expect('finishedAt' in (outcome ?? {})).toBe(false)
  })

  it('a FAILED row missing finishedAt reads running', () => {
    const row = fixtureRow({ status: 'FAILED', finishedAt: undefined })
    expect(toRunOutcome(row, 'ns_')?.status).toBe('running')
  })

  it('a COMPLETED row missing startedAt reads running', () => {
    const row = fixtureRow({ status: 'COMPLETED', startedAt: undefined })
    expect(toRunOutcome(row, 'ns_')?.status).toBe('running')
  })

  it('a FAILED row with finishedAt and no startedAt still reads failed (a run that ended before it started is a dead letter)', () => {
    const row = fixtureRow({ status: 'FAILED', startedAt: undefined })
    expect(toRunOutcome(row, 'ns_')?.status).toBe('failed')
  })

  it('a RUNNING row stays running regardless of its timestamps', () => {
    const row = fixtureRow({ status: 'RUNNING', startedAt: undefined, finishedAt: undefined })
    expect(toRunOutcome(row, 'ns_')?.status).toBe('running')
  })

  // A run cancelled while still queued never started.
  it('a CANCELLED row with neither timestamp still reads cancelled', () => {
    const row = fixtureRow({ status: 'CANCELLED', startedAt: undefined, finishedAt: undefined })
    expect(toRunOutcome(row, 'ns_')?.status).toBe('cancelled')
  })
})

interface FakeRunsReaderCalls {
  reader: RunsReader
  listCalls: () => Array<Parameters<HatchetClient['runs']['list']>[0]>
}

function fakeRunsReader(namespace: string, rows: EngineRunRow[], listError?: Error): FakeRunsReaderCalls {
  const calls: Array<Parameters<HatchetClient['runs']['list']>[0]> = []
  const reader: RunsReader = {
    config: { namespace },
    runs: {
      list: async (opts) => {
        calls.push(opts)
        if (listError !== undefined) throw listError
        return { pagination: {}, rows }
      },
    },
  }
  return { reader, listCalls: () => calls }
}

describe('readRunOutcomes', () => {
  it('returns an empty array when the engine returns zero rows', async () => {
    const { reader } = fakeRunsReader('ns_', [])
    const outcomes = await readRunOutcomes(reader, uuidv7())
    expect(outcomes).toEqual([])
  })

  it('defaults since to 5 minutes before the envelope id’s own uuid v7 timestamp', async () => {
    // A fixed id, not a fresh uuidv7(): its first 12 hex digits are the
    // ms timestamp 1704067200000 (2024-01-01T00:00:00.000Z), computed here
    // independently of the production code's own parsing, so this pins the
    // value rather than re-deriving the same expression.
    const envelopeId = '018cc251-f400-7000-8000-000000000000'
    const { reader, listCalls } = fakeRunsReader('ns_', [])
    await readRunOutcomes(reader, envelopeId)

    const since = listCalls()[0]?.since
    expect(since).toBeInstanceOf(Date)
    expect(since?.getTime()).toBe(Date.UTC(2024, 0, 1, 0, 0, 0, 0) - 5 * 60_000)
  })

  it('passes the caller’s since through unchanged', async () => {
    const envelopeId = uuidv7()
    const { reader, listCalls } = fakeRunsReader('ns_', [])
    const callerSince = new Date('2020-01-01T00:00:00.000Z')

    await readRunOutcomes(reader, envelopeId, { since: callerSince })

    expect(listCalls()[0]?.since).toBe(callerSince)
  })

  it('calls the engine with limit 100, includePayloads false and additionalMetadata exactly the envelope id', async () => {
    const envelopeId = uuidv7()
    const { reader, listCalls } = fakeRunsReader('ns_', [])

    await readRunOutcomes(reader, envelopeId)

    const call = listCalls()[0]
    expect(call?.limit).toBe(100)
    expect(call?.includePayloads).toBe(false)
    expect(call?.additionalMetadata).toEqual({ envelopeId })
  })

  it('throws KyuError when the engine reports more than one page', async () => {
    const calls: Array<unknown> = []
    const reader: RunsReader = {
      config: { namespace: 'ns_' },
      runs: {
        list: async (opts) => {
          calls.push(opts)
          return { pagination: { num_pages: 2 }, rows: [] }
        },
      },
    }

    await expect(readRunOutcomes(reader, uuidv7())).rejects.toThrow(KyuError)
  })

  it('throws KyuError and never calls runs.list for a malformed envelope id', async () => {
    const { reader, listCalls } = fakeRunsReader('ns_', [])

    await expect(readRunOutcomes(reader, 'not-a-uuid')).rejects.toThrow(KyuError)
    expect(listCalls()).toHaveLength(0)
  })

  it('throws KyuError and never calls runs.list for a uuid v4 (not a v7 envelope id)', async () => {
    const { reader, listCalls } = fakeRunsReader('ns_', [])

    await expect(readRunOutcomes(reader, '4c9b6e2a-6e3a-4b8b-9f1e-0f1a2b3c4d5e')).rejects.toThrow(KyuError)
    expect(listCalls()).toHaveLength(0)
  })

  it('wraps a rejected engine call in KyuError with the original error as cause', async () => {
    const cause = new Error('econnrefused')
    const { reader } = fakeRunsReader('ns_', [], cause)

    expect.assertions(2)
    try {
      await readRunOutcomes(reader, uuidv7())
    } catch (error) {
      expect(error).toBeInstanceOf(KyuError)
      expect(error).toHaveProperty('cause', cause)
    }
  })

  it('keeps only rows from this namespace, in the engine’s own order', async () => {
    const envelopeId = uuidv7()
    const rows = [
      fixtureRow({ workflowName: 'ns_first', taskExternalId: '018f0000-0000-7000-8000-000000000011' }),
      fixtureRow({ workflowName: 'other_second', taskExternalId: '018f0000-0000-7000-8000-000000000012' }),
      fixtureRow({ workflowName: 'ns_third', taskExternalId: '018f0000-0000-7000-8000-000000000013' }),
    ]
    const { reader } = fakeRunsReader('ns_', rows)

    const outcomes = await readRunOutcomes(reader, envelopeId)

    expect(outcomes.map((o) => o.subscription)).toEqual(['first', 'third'])
  })
})

describe('envelope id timestamp round trip', () => {
  it('a fresh uuidv7() decodes to within a few milliseconds of Date.now()', () => {
    const id = uuidv7()
    const hex = id.replaceAll('-', '').slice(0, 12)
    const mintedAt = Number.parseInt(hex, 16)
    expect(Math.abs(mintedAt - Date.now())).toBeLessThan(2_000)
  })
})
