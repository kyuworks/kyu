import { uuidv7 } from '@kyuworks/schemas'
import { describe, expect, it } from 'vitest'
import { KyuError } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import type { Queryable, QueryParam } from '../db/queryable.js'
import { cancelRunsFor } from './cancelRuns.js'
import type { RunsCanceller } from './cancelRuns.js'
import { runDetailFixture } from './__tests__/runDetailFixture.js'

// Copied from runOutcomes.test.ts's own fixtureRow: production source does
// not export test fixtures, and tests do not count toward the size gate.
type EngineRunRow = Awaited<ReturnType<HatchetClient['runs']['list']>>['rows'][number]

interface RowOverrides {
  status?: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'FAILED'
  workflowName?: string | undefined
  taskExternalId?: string
}

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
    status: (overrides.status ?? 'RUNNING') as EngineRunRow['status'],
    taskExternalId: overrides.taskExternalId ?? '018f0000-0000-7000-8000-000000000002',
    taskId: 1,
    taskInsertedAt: '2026-01-01T00:00:00.000Z',
    tenantId: '018f0000-0000-7000-8000-000000000003',
    type: 'TASK' as EngineRunRow['type'],
    workflowId: '018f0000-0000-7000-8000-000000000004',
    workflowRunExternalId: '018f0000-0000-7000-8000-000000000005',
    workflowName: 'ns_sample-run',
    startedAt: '2026-01-01T00:00:01.000Z',
  }

  if ('workflowName' in overrides) {
    const { workflowName } = overrides
    if (workflowName === undefined) delete row.workflowName
    else row.workflowName = workflowName
  }

  return row
}

interface FakeRunsCancellerCalls {
  canceller: RunsCanceller
  listCalls: () => Array<Parameters<HatchetClient['runs']['list']>[0]>
  cancelCalls: () => Array<Parameters<HatchetClient['runs']['cancel']>[0]>
}

type CancelProcedure = (
  opts: Parameters<HatchetClient['runs']['cancel']>[0],
) => ReturnType<HatchetClient['runs']['cancel']>

function fakeRunsCanceller(
  namespace: string,
  rows: EngineRunRow[],
  cancelError?: Error,
  detailError?: Error,
): FakeRunsCancellerCalls {
  const listCalls: Array<Parameters<HatchetClient['runs']['list']>[0]> = []
  const cancelCalls: Array<Parameters<HatchetClient['runs']['cancel']>[0]> = []
  const cancel: CancelProcedure = (opts) => {
    cancelCalls.push(opts)
    if (cancelError !== undefined) return Promise.reject(cancelError)
    // Only `data` is read by production code; the rest of AxiosResponse is never touched.
    return Promise.resolve({ data: { ids: opts.ids } } as Awaited<ReturnType<HatchetClient['runs']['cancel']>>)
  }
  const canceller: RunsCanceller = {
    config: { namespace },
    runs: {
      list: async (opts) => {
        listCalls.push(opts)
        return { pagination: {}, rows }
      },
      cancel,
      getDetails: async () => {
        if (detailError !== undefined) throw detailError
        return runDetailFixture()
      },
    },
  }
  return { canceller, listCalls: () => listCalls, cancelCalls: () => cancelCalls }
}

// One call's rows per page, in call order; `pagination.num_pages` is fixed
// at the page count, mirroring runOutcomes.test.ts's own fakePagedRunsReader.
function fakePagedRunsCanceller(namespace: string, pages: EngineRunRow[][]): FakeRunsCancellerCalls {
  const listCalls: Array<Parameters<HatchetClient['runs']['list']>[0]> = []
  const cancelCalls: Array<Parameters<HatchetClient['runs']['cancel']>[0]> = []
  const cancel: CancelProcedure = (opts) => {
    cancelCalls.push(opts)
    return Promise.resolve({ data: { ids: opts.ids } } as Awaited<ReturnType<HatchetClient['runs']['cancel']>>)
  }
  const canceller: RunsCanceller = {
    config: { namespace },
    runs: {
      list: async (opts) => {
        const rows = pages[listCalls.length] ?? []
        listCalls.push(opts)
        return { pagination: { num_pages: pages.length }, rows }
      },
      cancel,
      getDetails: async () => runDetailFixture(),
    },
  }
  return { canceller, listCalls: () => listCalls, cancelCalls: () => cancelCalls }
}

describe('cancelRunsFor', () => {
  it('sends every run id in this namespace to the engine’s cancel, and nothing else', async () => {
    const envelopeId = uuidv7()
    const rows = [
      fixtureRow({ workflowName: 'ns_first', taskExternalId: '018f0000-0000-7000-8000-000000000011' }),
      fixtureRow({ workflowName: 'other_second', taskExternalId: '018f0000-0000-7000-8000-000000000012' }),
      fixtureRow({ workflowName: 'ns_third', taskExternalId: '018f0000-0000-7000-8000-000000000013' }),
    ]
    const { canceller, cancelCalls } = fakeRunsCanceller('ns_', rows)

    const cancelled = await cancelRunsFor(canceller, {
      key: 'envelopeId',
      id: envelopeId,
      caller: 'runs.cancelForEnvelope',
    })

    expect(cancelCalls()).toEqual([
      { ids: ['018f0000-0000-7000-8000-000000000011', '018f0000-0000-7000-8000-000000000013'] },
    ])
    expect(cancelled.map((outcome) => outcome.subscription)).toEqual(['first', 'third'])
  })

  it('cancelForCorrelation matches the correlationId metadata key, not envelopeId', async () => {
    const correlationId = uuidv7()
    const { canceller, listCalls } = fakeRunsCanceller('ns_', [])

    await cancelRunsFor(canceller, { key: 'correlationId', id: correlationId, caller: 'runs.cancelForCorrelation' })

    expect(listCalls()[0]?.additionalMetadata).toEqual({ correlationId })
  })

  it('returns an empty array and never calls cancel when the lookup finds no runs', async () => {
    const envelopeId = uuidv7()
    const { canceller, cancelCalls } = fakeRunsCanceller('ns_', [])

    const cancelled = await cancelRunsFor(canceller, {
      key: 'envelopeId',
      id: envelopeId,
      caller: 'runs.cancelForEnvelope',
    })

    expect(cancelled).toEqual([])
    expect(cancelCalls()).toHaveLength(0)
  })

  it('throws KyuError and never lists or cancels for a correlation id that is not uuid v7', async () => {
    const { canceller, listCalls, cancelCalls } = fakeRunsCanceller('ns_', [])

    await expect(
      cancelRunsFor(canceller, {
        key: 'correlationId',
        id: '4c9b6e2a-6e3a-4b8b-9f1e-0f1a2b3c4d5e',
        caller: 'runs.cancelForCorrelation',
      }),
    ).rejects.toThrow(KyuError)
    expect(listCalls()).toHaveLength(0)
    expect(cancelCalls()).toHaveLength(0)
  })

  it('wraps a rejected engine cancel in KyuError with the original error as cause', async () => {
    const envelopeId = uuidv7()
    const cause = new Error('econnrefused')
    const rows = [fixtureRow({ workflowName: 'ns_first' })]
    const { canceller } = fakeRunsCanceller('ns_', rows, cause)

    expect.assertions(2)
    try {
      await cancelRunsFor(canceller, { key: 'envelopeId', id: envelopeId, caller: 'runs.cancelForEnvelope' })
    } catch (error) {
      expect(error).toBeInstanceOf(KyuError)
      expect(error).toHaveProperty('cause', cause)
    }
  })

  it('cancelForCorrelation sends every run id from every page to cancel, in one call', async () => {
    const correlationId = uuidv7()
    const rowsPage1 = [fixtureRow({ workflowName: 'ns_first', taskExternalId: '018f0000-0000-7000-8000-000000000011' })]
    const rowsPage2 = [
      fixtureRow({ workflowName: 'ns_second', taskExternalId: '018f0000-0000-7000-8000-000000000012' }),
    ]
    const { canceller, cancelCalls } = fakePagedRunsCanceller('ns_', [rowsPage1, rowsPage2])

    const cancelled = await cancelRunsFor(canceller, {
      key: 'correlationId',
      id: correlationId,
      caller: 'runs.cancelForCorrelation',
    })

    expect(cancelCalls()).toEqual([
      { ids: ['018f0000-0000-7000-8000-000000000011', '018f0000-0000-7000-8000-000000000012'] },
    ])
    expect(cancelled.map((outcome) => outcome.subscription)).toEqual(['first', 'second'])
  })

  it('throws KyuError and never calls cancel when the correlation id covers more pages than the ceiling', async () => {
    const correlationId = uuidv7()
    const { canceller, cancelCalls } = fakePagedRunsCanceller(
      'ns_',
      Array.from({ length: 11 }, () => []),
    )

    await expect(
      cancelRunsFor(canceller, { key: 'correlationId', id: correlationId, caller: 'runs.cancelForCorrelation' }),
    ).rejects.toThrow(KyuError)
    expect(cancelCalls()).toHaveLength(0)
  })

  it('returns the outcomes unchanged when every run is already cancelled', async () => {
    const envelopeId = uuidv7()
    const rows = [fixtureRow({ workflowName: 'ns_first', status: 'CANCELLED' })]
    const { canceller, cancelCalls } = fakeRunsCanceller('ns_', rows)

    const cancelled = await cancelRunsFor(canceller, {
      key: 'envelopeId',
      id: envelopeId,
      caller: 'runs.cancelForEnvelope',
    })

    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]?.status).toBe('cancelled')
    expect(cancelCalls()).toEqual([{ ids: ['018f0000-0000-7000-8000-000000000002'] }])
  })

  // A cancel sends every listed run id regardless of its status, so a failed
  // detail read on a long-unsettled row must not stop the cancel from being sent.
  it('still sends the cancel when the run detail read fails for a long-unsettled row', async () => {
    const envelopeId = uuidv7()
    const cause = new Error('unavailable')
    const rows = [fixtureRow({ workflowName: 'ns_first', status: 'RUNNING' })]
    const { canceller, cancelCalls } = fakeRunsCanceller('ns_', rows, undefined, cause)

    const cancelled = await cancelRunsFor(canceller, {
      key: 'envelopeId',
      id: envelopeId,
      caller: 'runs.cancelForEnvelope',
    })

    expect(cancelCalls()).toEqual([{ ids: ['018f0000-0000-7000-8000-000000000002'] }])
    expect(cancelled.map((outcome) => outcome.status)).toEqual(['running'])
  })
})

interface OutboxCall {
  text: string
  params: readonly QueryParam[]
  engineCancelsBefore: number
}

interface RecordingOutbox {
  outbox: Queryable
  calls: OutboxCall[]
}

// Records each statement and how many engine cancels had happened by then.
function recordingOutbox(engineCancels: () => number, failWith?: Error): RecordingOutbox {
  const calls: OutboxCall[] = []
  const outbox: Queryable = {
    query(text, params) {
      calls.push({ text, params, engineCancelsBefore: engineCancels() })
      if (failWith !== undefined) return Promise.reject(failWith)
      return Promise.resolve({ rows: [], rowCount: 1 })
    },
  }
  return { outbox, calls }
}

describe('cancelRunsFor with the caller’s outbox (#180)', () => {
  it('cancels the scheduled rows under the correlation id, after the engine cancel', async () => {
    const correlationId = uuidv7()
    const { canceller, cancelCalls } = fakeRunsCanceller('ns_', [fixtureRow({ workflowName: 'ns_run-workflow' })])
    const { outbox, calls } = recordingOutbox(() => cancelCalls().length)

    await cancelRunsFor(
      canceller,
      { key: 'correlationId', id: correlationId, caller: 'runs.cancelForCorrelation' },
      { outbox },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toContain('SET cancelled_at = now()')
    expect(calls[0]?.params).toEqual(['correlationId', correlationId])
    expect(calls[0]?.engineCancelsBefore).toBe(1)
  })

  it('a cancel by envelope id takes the rows that envelope caused, even with no run on the engine', async () => {
    const envelopeId = uuidv7()
    const { canceller, cancelCalls } = fakeRunsCanceller('ns_', [])
    const { outbox, calls } = recordingOutbox(() => cancelCalls().length)

    await cancelRunsFor(canceller, { key: 'envelopeId', id: envelopeId, caller: 'runs.cancelForEnvelope' }, { outbox })

    expect(cancelCalls()).toEqual([])
    expect(calls.map((call) => call.params)).toEqual([['causationId', envelopeId]])
  })

  it('leaves the outbox untouched when the engine cancel fails', async () => {
    const { canceller, cancelCalls } = fakeRunsCanceller('ns_', [fixtureRow()], new Error('engine down'))
    const { outbox, calls } = recordingOutbox(() => cancelCalls().length)

    await expect(
      cancelRunsFor(canceller, { key: 'correlationId', id: uuidv7(), caller: 'runs.cancelForCorrelation' }, { outbox }),
    ).rejects.toThrow(KyuError)
    expect(calls).toEqual([])
  })

  it('reports an outbox failure as a KyuError naming the caller', async () => {
    const { canceller, cancelCalls } = fakeRunsCanceller('ns_', [])
    const { outbox } = recordingOutbox(() => cancelCalls().length, new Error('connection lost'))

    await expect(
      cancelRunsFor(canceller, { key: 'correlationId', id: uuidv7(), caller: 'runs.cancelForCorrelation' }, { outbox }),
    ).rejects.toThrow('runs.cancelForCorrelation: could not cancel scheduled outbox rows')
  })
})
