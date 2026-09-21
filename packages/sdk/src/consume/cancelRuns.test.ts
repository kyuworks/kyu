import { uuidv7 } from '@kyuworks/schemas'
import { describe, expect, it } from 'vitest'
import { KyuError } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import { cancelRunsFor } from './cancelRuns.js'
import type { RunsCanceller } from './cancelRuns.js'

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

function fakeRunsCanceller(namespace: string, rows: EngineRunRow[], cancelError?: Error): FakeRunsCancellerCalls {
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
})
