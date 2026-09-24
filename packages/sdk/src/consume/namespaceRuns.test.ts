import { describe, expect, it } from 'vitest'
import { V1TaskStatus } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import type { Queryable, QueryParam } from '../db/queryable.js'
import {
  cancelUnsettledRunsForTenant,
  cancelUnsettledRunsInNamespace,
  readUnsettledRunsForTenant,
  readUnsettledRunsInNamespace,
} from './namespaceRuns.js'
import type { NamespaceRunsClient } from './namespaceRuns.js'
import { runDetailFixture } from './__tests__/runDetailFixture.js'
import type { EngineRunDetail } from './__tests__/runDetailFixture.js'

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
  detailCalls: () => string[]
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
  details?: ReadonlyMap<string, EngineRunDetail>
}): FakeCalls {
  const workflowPages = options.workflowPages ?? [[fixtureWorkflow(`${options.namespace}sample-run`)]]
  const runPages = options.runPages ?? [[]]
  const listCalls: Array<Parameters<HatchetClient['runs']['list']>[0]> = []
  const cancelCalls: Array<Parameters<HatchetClient['runs']['cancel']>[0]> = []
  const workflowListCalls: Array<Parameters<HatchetClient['workflows']['list']>[0]> = []
  const detailCalls: string[] = []

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
      getDetails: async (runId: string) => {
        detailCalls.push(runId)
        return options.details?.get(runId) ?? runDetailFixture()
      },
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
    detailCalls: () => detailCalls,
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

  it('never lists workflows or sends a cancel for the empty namespace', async () => {
    const { client, workflowListCalls, cancelCalls } = fakeNamespaceRunsClient({ namespace: '' })

    const cancelled = await cancelUnsettledRunsInNamespace(client, { since: new Date('2026-01-01') })

    expect(cancelled).toBe(0)
    expect(workflowListCalls()).toHaveLength(0)
    expect(cancelCalls()).toHaveLength(0)
  })

  it('names itself, not unsettledInNamespace, when the namespace holds too many workflows', async () => {
    const workflowPages = Array.from({ length: 11 }, (_, page) =>
      Array.from({ length: 100 }, (_, i) => fixtureWorkflow(`ns_wf-${String(page * 100 + i)}`)),
    )
    const { client } = fakeNamespaceRunsClient({ namespace: 'ns_', workflowPages })

    await expect(cancelUnsettledRunsInNamespace(client, { since: new Date('2026-01-01') })).rejects.toThrow(
      'runs.cancelUnsettledInNamespace: namespace "ns_" holds more than 1000 workflows',
    )
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

  it('never lists workflows or runs for the empty namespace', async () => {
    const { client, workflowListCalls, listCalls } = fakeNamespaceRunsClient({ namespace: '' })

    const outcomes = await readUnsettledRunsInNamespace(client, { since: new Date('2026-01-01') })

    expect(outcomes).toEqual([])
    expect(workflowListCalls()).toHaveLength(0)
    expect(listCalls()).toHaveLength(0)
  })

  it('leaves out a run the run detail says completed or failed, and never reads the detail for another namespace', async () => {
    const id = (n: number): string => `018f0000-0000-7000-8000-0000000000${String(n)}`
    const rows = [
      fixtureRow({ workflowName: 'ns_stale', status: 'RUNNING', taskExternalId: id(31) }),
      fixtureRow({ workflowName: 'ns_failed', status: 'RUNNING', taskExternalId: id(32) }),
      fixtureRow({ workflowName: 'ns_live', status: 'QUEUED', taskExternalId: id(33) }),
      fixtureRow({ workflowName: 'ns_cancelled', status: 'RUNNING', taskExternalId: id(34) }),
      fixtureRow({ workflowName: 'other_done', status: 'RUNNING', taskExternalId: id(35) }),
    ]
    const details = new Map([
      [id(31), runDetailFixture(V1TaskStatus.COMPLETED)],
      [id(32), runDetailFixture(V1TaskStatus.FAILED)],
      [id(33), runDetailFixture(V1TaskStatus.QUEUED)],
      [id(34), runDetailFixture(V1TaskStatus.CANCELLED)],
      [id(35), runDetailFixture(V1TaskStatus.COMPLETED)],
    ])
    const { client, detailCalls } = fakeNamespaceRunsClient({ namespace: 'ns_', runPages: [rows], details })

    const outcomes = await readUnsettledRunsInNamespace(client, { since: new Date('2026-01-01') })

    expect(outcomes.map((outcome) => outcome.subscription)).toEqual(['live', 'cancelled'])
    expect(detailCalls()).toEqual([id(31), id(32), id(33), id(34)])
  })

  it('reads the run detail for at most 100 runs per call, across pages', async () => {
    const id = (n: number): string => `018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`
    const all = Array.from({ length: 101 }, (_unused, n) => fixtureRow({ status: 'RUNNING', taskExternalId: id(n) }))
    const { client, detailCalls } = fakeNamespaceRunsClient({
      namespace: 'ns_',
      runPages: [all.slice(0, 100), all.slice(100)],
    })

    const outcomes = await readUnsettledRunsInNamespace(client, { since: new Date('2026-01-01') })

    expect(outcomes).toHaveLength(101)
    expect(detailCalls()).toHaveLength(100)
    expect(detailCalls().at(-1)).toBe(id(99))
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

// Copied from cancelRuns.test.ts: records each statement and how many engine cancels had happened by then.
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

const TENANT = '018f0000-0000-7000-8000-0000000000a1'
const since = new Date('2026-01-01')

describe('cancelUnsettledRunsForTenant (#182)', () => {
  it('never sends a cancel when the namespace has no registered workflow', async () => {
    const { client, cancelCalls } = fakeNamespaceRunsClient({ namespace: 'ns_', workflowPages: [[]] })
    expect(await cancelUnsettledRunsForTenant(client, TENANT, { since })).toBe(0)
    expect(cancelCalls()).toHaveLength(0)
  })

  it('sends one cancel naming this namespace’s workflows and the tenant id as run metadata', async () => {
    const { client, cancelCalls } = fakeNamespaceRunsClient({
      namespace: 'ns_',
      workflowPages: [[fixtureWorkflow('ns_record-order'), fixtureWorkflow('other_thing')]],
    })
    expect(await cancelUnsettledRunsForTenant(client, TENANT, { since })).toBe(2)
    expect(cancelCalls()).toHaveLength(1)
    expect(cancelCalls()[0]?.filters?.workflowNames).toEqual(['ns_record-order'])
    expect(cancelCalls()[0]?.filters?.additionalMetadata).toEqual({ tenantId: TENANT })
  })

  it('throws KyuError and never lists workflows for a tenant id that is not a uuid', async () => {
    const { client, workflowListCalls, cancelCalls } = fakeNamespaceRunsClient({ namespace: 'ns_' })
    await expect(cancelUnsettledRunsForTenant(client, 'tenant-a', { since })).rejects.toThrow(
      'runs.cancelForTenant: "tenant-a" is not a uuid tenant id',
    )
    expect(workflowListCalls()).toHaveLength(0)
    expect(cancelCalls()).toHaveLength(0)
  })

  it('with the outbox, cancels that tenant’s scheduled rows after the engine cancel', async () => {
    const { client, cancelCalls } = fakeNamespaceRunsClient({ namespace: 'ns_' })
    const { outbox, calls } = recordingOutbox(() => cancelCalls().length)
    await cancelUnsettledRunsForTenant(client, TENANT, { since, outbox })
    expect(calls.map((call) => [call.params, call.engineCancelsBefore])).toEqual([[['tenantId', TENANT], 1]])
  })

  it('leaves the outbox untouched when the engine cancel fails', async () => {
    const { client, cancelCalls } = fakeNamespaceRunsClient({ namespace: 'ns_', cancelError: new Error('engine down') })
    const { outbox, calls } = recordingOutbox(() => cancelCalls().length)
    await expect(cancelUnsettledRunsForTenant(client, TENANT, { since, outbox })).rejects.toThrow(
      'runs.cancelForTenant: could not cancel runs in namespace "ns_"',
    )
    expect(calls).toEqual([])
  })
})

describe('readUnsettledRunsForTenant (#182)', () => {
  it('lists runs by this namespace’s workflows and the tenant id as run metadata', async () => {
    const { client, listCalls } = fakeNamespaceRunsClient({
      namespace: 'ns_',
      runPages: [[fixtureRow({ workflowName: 'ns_sample-run', status: 'QUEUED' })]],
    })
    const outcomes = await readUnsettledRunsForTenant(client, TENANT, { since })
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['queued'])
    expect(listCalls()[0]?.workflowNames).toEqual(['ns_sample-run'])
    expect(listCalls()[0]?.additionalMetadata).toEqual({ tenantId: TENANT })
  })

  it('returns an empty array and never lists runs when the namespace has no registered workflow', async () => {
    const { client, listCalls } = fakeNamespaceRunsClient({ namespace: 'ns_', workflowPages: [[]] })
    expect(await readUnsettledRunsForTenant(client, TENANT, { since })).toEqual([])
    expect(listCalls()).toHaveLength(0)
  })
})

describe('cancelUnsettledRunsInNamespace after #182', () => {
  it('still names no tenant in its cancel', async () => {
    const { client, cancelCalls } = fakeNamespaceRunsClient({ namespace: 'ns_' })
    await cancelUnsettledRunsInNamespace(client, { since })
    expect(cancelCalls()[0]?.filters?.additionalMetadata).toEqual({})
  })
})
