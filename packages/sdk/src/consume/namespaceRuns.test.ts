import { describe, expect, it } from 'vitest'
import type { HatchetClient } from '../hatchet.js'
import { cancelUnsettledRunsInNamespace, readUnsettledRunsInNamespace } from './namespaceRuns.js'
import type { NamespaceRunsClient } from './namespaceRuns.js'

// Copied from runOutcomes.test.ts's own fixtureRow: production source does
// not export test fixtures, and tests do not count toward the size gate.
type EngineRunRow = Awaited<ReturnType<HatchetClient['runs']['list']>>['rows'][number]
type EngineWorkflowRow = NonNullable<Awaited<ReturnType<HatchetClient['workflows']['list']>>['rows']>[number]

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

function fixtureWorkflow(name: string): EngineWorkflowRow {
  return { metadata: { id: name, createdAt: '', updatedAt: '' }, name } as EngineWorkflowRow
}

interface FakeCalls {
  client: NamespaceRunsClient
  listCalls: () => Array<Parameters<HatchetClient['runs']['list']>[0]>
  cancelCalls: () => Array<Parameters<HatchetClient['runs']['cancel']>[0]>
  workflowListCalls: () => Array<Parameters<HatchetClient['workflows']['list']>[0]>
}

type CancelProcedure = (
  opts: Parameters<HatchetClient['runs']['cancel']>[0],
) => ReturnType<HatchetClient['runs']['cancel']>

// One page of workflows and one page of runs, unless workflowPages/runPages say otherwise.
function fakeNamespaceRunsClient(options: {
  namespace: string
  workflowPages?: EngineWorkflowRow[][]
  runPages?: EngineRunRow[][]
  cancelError?: Error
}): FakeCalls {
  const workflowPages = options.workflowPages ?? [[fixtureWorkflow(`${options.namespace}sample-run`)]]
  const runPages = options.runPages ?? [[]]
  const listCalls: Array<Parameters<HatchetClient['runs']['list']>[0]> = []
  const cancelCalls: Array<Parameters<HatchetClient['runs']['cancel']>[0]> = []
  const workflowListCalls: Array<Parameters<HatchetClient['workflows']['list']>[0]> = []

  const cancel: CancelProcedure = (opts) => {
    cancelCalls.push(opts)
    if (options.cancelError !== undefined) return Promise.reject(options.cancelError)
    return Promise.resolve({ data: { ids: ['a', 'b'] } } as Awaited<ReturnType<HatchetClient['runs']['cancel']>>)
  }

  const client: NamespaceRunsClient = {
    config: { namespace: options.namespace },
    runs: {
      list: async (opts) => {
        const rows = runPages[listCalls.length] ?? []
        listCalls.push(opts)
        return { pagination: { num_pages: runPages.length }, rows }
      },
      cancel,
    },
    workflows: {
      list: async (opts) => {
        const rows = workflowPages[workflowListCalls.length] ?? []
        workflowListCalls.push(opts)
        return { rows }
      },
    },
  }
  return {
    client,
    listCalls: () => listCalls,
    cancelCalls: () => cancelCalls,
    workflowListCalls: () => workflowListCalls,
  }
}

describe('cancelUnsettledRunsInNamespace', () => {
  it('never sends a cancel when the namespace has no registered workflow', async () => {
    const { client, cancelCalls } = fakeNamespaceRunsClient({ namespace: 'ns_', workflowPages: [[]] })

    const cancelled = await cancelUnsettledRunsInNamespace(client, { since: new Date('2026-01-01') })

    expect(cancelled).toBe(0)
    expect(cancelCalls()).toHaveLength(0)
  })

  it('sends one cancel naming every workflow in this namespace and nothing else', async () => {
    const { client, cancelCalls } = fakeNamespaceRunsClient({
      namespace: 'ns_',
      workflowPages: [
        [fixtureWorkflow('ns_record-order'), fixtureWorkflow('other_thing'), fixtureWorkflow('ns_watch-shipping')],
      ],
    })

    await cancelUnsettledRunsInNamespace(client, { since: new Date('2026-01-01') })

    expect(cancelCalls()).toHaveLength(1)
    expect(cancelCalls()[0]?.filters?.workflowNames).toEqual(['ns_record-order', 'ns_watch-shipping'])
  })

  it("pages workflows past the engine's default page size", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => fixtureWorkflow(`ns_wf-${String(i)}`))
    const page2 = Array.from({ length: 7 }, (_, i) => fixtureWorkflow(`ns_wf-${String(100 + i)}`))
    const { client, cancelCalls, workflowListCalls } = fakeNamespaceRunsClient({
      namespace: 'ns_',
      workflowPages: [page1, page2],
    })

    await cancelUnsettledRunsInNamespace(client, { since: new Date('2026-01-01') })

    expect(cancelCalls()[0]?.filters?.workflowNames).toHaveLength(107)
    expect(workflowListCalls()).toHaveLength(2)
    expect(workflowListCalls()[0]?.offset).toBe(0)
    expect(workflowListCalls()[1]?.offset).toBe(100)
  })

  it('returns the number of run ids the engine reported cancelled', async () => {
    const { client } = fakeNamespaceRunsClient({ namespace: 'ns_' })

    const cancelled = await cancelUnsettledRunsInNamespace(client, { since: new Date('2026-01-01') })

    expect(cancelled).toBe(2)
  })

  it('wraps a rejected engine cancel in KyuError with the original error as cause', async () => {
    const cause = new Error('econnrefused')
    const { client } = fakeNamespaceRunsClient({ namespace: 'ns_', cancelError: cause })

    expect.assertions(2)
    try {
      await cancelUnsettledRunsInNamespace(client, { since: new Date('2026-01-01') })
    } catch (error) {
      const { KyuError } = await import('../hatchet.js')
      expect(error).toBeInstanceOf(KyuError)
      expect(error).toHaveProperty('cause', cause)
    }
  })
})

describe('readUnsettledRunsInNamespace', () => {
  it('reads every page of unsettled runs and drops rows from another namespace', async () => {
    const rowsPage1 = [
      fixtureRow({
        workflowName: 'ns_first',
        status: 'QUEUED',
        taskExternalId: '018f0000-0000-7000-8000-000000000011',
      }),
      fixtureRow({
        workflowName: 'other_second',
        status: 'RUNNING',
        taskExternalId: '018f0000-0000-7000-8000-000000000012',
      }),
    ]
    const rowsPage2 = [
      fixtureRow({
        workflowName: 'ns_third',
        status: 'RUNNING',
        taskExternalId: '018f0000-0000-7000-8000-000000000013',
      }),
    ]
    const { client } = fakeNamespaceRunsClient({ namespace: 'ns_', runPages: [rowsPage1, rowsPage2] })

    const outcomes = await readUnsettledRunsInNamespace(client, { since: new Date('2026-01-01') })

    expect(outcomes.map((outcome) => outcome.subscription)).toEqual(['first', 'third'])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['queued', 'running'])
  })

  it('returns an empty array and never lists runs when the namespace has no registered workflow', async () => {
    const { client, listCalls } = fakeNamespaceRunsClient({ namespace: 'ns_', workflowPages: [[]] })

    const outcomes = await readUnsettledRunsInNamespace(client, { since: new Date('2026-01-01') })

    expect(outcomes).toEqual([])
    expect(listCalls()).toHaveLength(0)
  })
})
