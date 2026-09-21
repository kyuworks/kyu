import { createEnvelope, defineEvent, uuidv7 } from '@kyuworks/schemas'
import type { Envelope, MessageDataShape } from '@kyuworks/schemas'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { EnvelopeRejectedError, KyuError } from '../errors.js'
import { OrCondition, SleepCondition, UserEventCondition } from '../hatchet.js'
import type { DurableContext, HatchetClient, JsonObject } from '../hatchet.js'
import { buildChildConditions, waitForChildMessages } from './fanOut.js'
import type { RunsReader } from './runOutcomes.js'

const childReplied = defineEvent({
  name: 'kyu.fan_out.child_replied',
  version: 1,
  data: z.object({ childEnvelopeId: z.string() }),
})

async function handlerEnvelope(tenantId: string | null): Promise<Envelope<MessageDataShape>> {
  return createEnvelope(childReplied, { childEnvelopeId: 'n/a' }, { tenantId, source: 'sdk.test' })
}

describe('buildChildConditions', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')

  it('builds one Or group per child, each pairing a reply condition with its own timeout sleep', async () => {
    const envelope = await handlerEnvelope(null)
    const ids = [uuidv7(), uuidv7(), uuidv7()]

    const groups = buildChildConditions(
      envelope,
      childReplied,
      { where: { field: 'data.childEnvelopeId', envelopeIds: ids }, timeout: '30s' },
      now,
    )

    expect(groups).toHaveLength(3)
    for (const group of groups) {
      expect(group).toBeInstanceOf(OrCondition)
      expect(group.conditions).toHaveLength(2)
      expect(group.conditions[0]).toBeInstanceOf(UserEventCondition)
      expect(group.conditions[1]).toBeInstanceOf(SleepCondition)
    }
  })

  it('keys each child condition by its index so a matched reply is attributable', async () => {
    const envelope = await handlerEnvelope(null)
    const ids = [uuidv7(), uuidv7(), uuidv7()]

    const groups = buildChildConditions(
      envelope,
      childReplied,
      { where: { field: 'data.childEnvelopeId', envelopeIds: ids }, timeout: '30s' },
      now,
    )

    groups.forEach((group, index) => {
      expect(group.conditions[0]?.base.readableDataKey).toBe(`child-${index}`)
      expect(group.conditions[1]?.base.readableDataKey).toBe(`timeout-${index}`)
    })
  })

  it('pins each expression to the child envelope id and the reply definition version', async () => {
    const envelope = await handlerEnvelope(null)
    const ids = [uuidv7(), uuidv7()]

    const groups = buildChildConditions(
      envelope,
      childReplied,
      { where: { field: 'data.childEnvelopeId', envelopeIds: ids }, timeout: '30s' },
      now,
    )

    groups.forEach((group, index) => {
      const [reply] = group.conditions
      const userEvent = reply instanceof UserEventCondition ? reply : undefined
      expect(userEvent?.expression).toBe(`input.data.childEnvelopeId == "${ids[index]}" && input.version == 1`)
    })
  })

  it('defaults scope to the handler envelope tenant id', async () => {
    const envelope = await handlerEnvelope('a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a')
    const ids = [uuidv7()]

    const groups = buildChildConditions(
      envelope,
      childReplied,
      { where: { field: 'data.childEnvelopeId', envelopeIds: ids }, timeout: '30s' },
      now,
    )

    const [reply] = groups[0]?.conditions ?? []
    const userEvent = reply instanceof UserEventCondition ? reply : undefined
    expect(userEvent?.scope).toBe('a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a')
  })
})

interface FakeDurableContext {
  context: DurableContext<JsonObject>
  capturedConditions: () => Parameters<DurableContext<JsonObject>['waitFor']>[0] | undefined
}

// Copied from durable.test.ts rather than imported: the two suites must not
// import each other. DurableContext carries private fields, so a Pick of the
// two members waitForChildMessages calls needs a single, unchained `as` cast
// to stand in for it.
function fakeDurableContext(
  waitForResult: Awaited<ReturnType<DurableContext<JsonObject>['waitFor']>>,
): FakeDurableContext {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let captured: Parameters<DurableContext<JsonObject>['waitFor']>[0] | undefined
  const stub: Pick<DurableContext<JsonObject>, 'now' | 'waitFor'> = {
    now: () => Promise.resolve(now),
    waitFor: (conditions) => {
      captured = conditions
      return Promise.resolve(waitForResult)
    },
  }
  return { context: stub as DurableContext<JsonObject>, capturedConditions: () => captured }
}

type EngineRunRow = Awaited<ReturnType<HatchetClient['runs']['list']>>['rows'][number]

interface RowOverrides {
  status?: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'FAILED'
  errorMessage?: string
  workflowName?: string
  startedAt?: string | undefined
  finishedAt?: string | undefined
}

// Trimmed copy of runOutcomes.test.ts's fixtureRow: only the fields this
// file's cases vary.
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
    taskExternalId: '018f0000-0000-7000-8000-000000000002',
    taskId: 1,
    taskInsertedAt: '2026-01-01T00:00:00.000Z',
    tenantId: '018f0000-0000-7000-8000-000000000003',
    type: 'TASK' as EngineRunRow['type'],
    workflowId: '018f0000-0000-7000-8000-000000000004',
    workflowRunExternalId: '018f0000-0000-7000-8000-000000000005',
    workflowName: overrides.workflowName ?? 'ns_child-sub',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
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
  if (overrides.errorMessage !== undefined) row.errorMessage = overrides.errorMessage
  return row
}

// A RunsReader fixture keyed by the envelopeId the caller filters on, in the
// same shape runOutcomes.test.ts's fakeRunsReader takes — narrowed here to
// route by additionalMetadata.envelopeId since one call covers several children.
function fakeRunsReader(namespace: string, rowsByEnvelopeId: ReadonlyMap<string, EngineRunRow[]>): RunsReader {
  return {
    config: { namespace },
    runs: {
      list: async (opts) => {
        const envelopeId = opts?.additionalMetadata?.['envelopeId']
        const rows = envelopeId !== undefined ? (rowsByEnvelopeId.get(envelopeId) ?? []) : []
        return { pagination: {}, rows }
      },
    },
  }
}

function asIncoming<T extends object>(value: T): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

describe('waitForChildMessages', () => {
  it('rejects a where.field that is not a dotted identifier path', async () => {
    const { context } = fakeDurableContext({ CREATE: {} })
    const envelope = await handlerEnvelope(null)
    const runs = fakeRunsReader('ns_', new Map())

    await expect(
      waitForChildMessages(context, runs, envelope, childReplied, {
        where: { field: 'data.childEnvelopeId == "x" || true', envelopeIds: [uuidv7()] },
        timeout: '30s',
      }),
    ).rejects.toBeInstanceOf(KyuError)
  })

  it('rejects a child envelope id that is not a uuid v7', async () => {
    const { context } = fakeDurableContext({ CREATE: {} })
    const envelope = await handlerEnvelope(null)
    const runs = fakeRunsReader('ns_', new Map())

    await expect(
      waitForChildMessages(context, runs, envelope, childReplied, {
        where: { field: 'data.childEnvelopeId', envelopeIds: ['not-a-uuid'] },
        timeout: '30s',
      }),
    ).rejects.toBeInstanceOf(KyuError)
  })

  it('rejects a duplicate child envelope id', async () => {
    const { context } = fakeDurableContext({ CREATE: {} })
    const envelope = await handlerEnvelope(null)
    const runs = fakeRunsReader('ns_', new Map())
    const id = uuidv7()

    await expect(
      waitForChildMessages(context, runs, envelope, childReplied, {
        where: { field: 'data.childEnvelopeId', envelopeIds: [id, id] },
        timeout: '30s',
      }),
    ).rejects.toBeInstanceOf(KyuError)
  })

  it('rejects an empty child list and a list over the 50-child cap', async () => {
    const { context } = fakeDurableContext({ CREATE: {} })
    const envelope = await handlerEnvelope(null)
    const runs = fakeRunsReader('ns_', new Map())

    await expect(
      waitForChildMessages(context, runs, envelope, childReplied, {
        where: { field: 'data.childEnvelopeId', envelopeIds: [] },
        timeout: '30s',
      }),
    ).rejects.toBeInstanceOf(KyuError)

    const tooMany = Array.from({ length: 51 }, () => uuidv7())
    await expect(
      waitForChildMessages(context, runs, envelope, childReplied, {
        where: { field: 'data.childEnvelopeId', envelopeIds: tooMany },
        timeout: '30s',
      }),
    ).rejects.toBeInstanceOf(KyuError)
  })

  it('reports a replied child even when its own timeout key also fired', async () => {
    const id = uuidv7()
    const reply = await createEnvelope(childReplied, { childEnvelopeId: id }, { tenantId: null, source: 'sdk.test' })
    const { context } = fakeDurableContext({
      CREATE: { 'child-0': [asIncoming(reply)], 'timeout-0': [{ sleep_duration: '30s' }] },
    })
    const envelope = await handlerEnvelope(null)
    const runs = fakeRunsReader('ns_', new Map())

    const outcomes = await waitForChildMessages(context, runs, envelope, childReplied, {
      where: { field: 'data.childEnvelopeId', envelopeIds: [id] },
      timeout: '30s',
    })

    expect(outcomes).toEqual([{ envelopeId: id, status: 'replied', envelope: reply }])
  })

  it('reads matches from an older engine that returns the CREATE map unwrapped', async () => {
    const id = uuidv7()
    const reply = await createEnvelope(childReplied, { childEnvelopeId: id }, { tenantId: null, source: 'sdk.test' })
    const { context } = fakeDurableContext({ 'child-0': [asIncoming(reply)] })
    const envelope = await handlerEnvelope(null)
    const runs = fakeRunsReader('ns_', new Map())

    const outcomes = await waitForChildMessages(context, runs, envelope, childReplied, {
      where: { field: 'data.childEnvelopeId', envelopeIds: [id] },
      timeout: '30s',
    })

    expect(outcomes).toEqual([{ envelopeId: id, status: 'replied', envelope: reply }])
  })

  it('reports a child with no reply and a failed engine run as failed, carrying the engine error', async () => {
    const id = uuidv7()
    const { context } = fakeDurableContext({ CREATE: { 'timeout-0': [{ sleep_duration: '30s' }] } })
    const envelope = await handlerEnvelope(null)
    const runs = fakeRunsReader('ns_', new Map([[id, [fixtureRow({ status: 'FAILED', errorMessage: 'boom' })]]]))

    const outcomes = await waitForChildMessages(context, runs, envelope, childReplied, {
      where: { field: 'data.childEnvelopeId', envelopeIds: [id] },
      timeout: '30s',
    })

    expect(outcomes).toEqual([{ envelopeId: id, status: 'failed', error: 'boom' }])
  })

  it('reports a child with no reply and a cancelled engine run as failed', async () => {
    const id = uuidv7()
    const { context } = fakeDurableContext({ CREATE: { 'timeout-0': [{ sleep_duration: '30s' }] } })
    const envelope = await handlerEnvelope(null)
    const runs = fakeRunsReader(
      'ns_',
      new Map([[id, [fixtureRow({ status: 'CANCELLED', startedAt: undefined, finishedAt: undefined })]]]),
    )

    const outcomes = await waitForChildMessages(context, runs, envelope, childReplied, {
      where: { field: 'data.childEnvelopeId', envelopeIds: [id] },
      timeout: '30s',
    })

    expect(outcomes).toEqual([{ envelopeId: id, status: 'failed' }])
  })

  it('reports a child with no reply and no terminal run as pending', async () => {
    const id = uuidv7()
    const { context } = fakeDurableContext({ CREATE: { 'timeout-0': [{ sleep_duration: '30s' }] } })
    const envelope = await handlerEnvelope(null)
    const runs = fakeRunsReader('ns_', new Map([[id, [fixtureRow({ status: 'RUNNING' })]]]))

    const outcomes = await waitForChildMessages(context, runs, envelope, childReplied, {
      where: { field: 'data.childEnvelopeId', envelopeIds: [id] },
      timeout: '30s',
    })

    expect(outcomes).toEqual([{ envelopeId: id, status: 'pending' }])
  })

  it('returns one outcome per child, in the order the ids were given', async () => {
    const [repliedId, failedId, pendingId] = [uuidv7(), uuidv7(), uuidv7()]
    const reply = await createEnvelope(
      childReplied,
      { childEnvelopeId: repliedId },
      { tenantId: null, source: 'sdk.test' },
    )
    const { context } = fakeDurableContext({
      CREATE: {
        'child-0': [asIncoming(reply)],
        'timeout-1': [{ sleep_duration: '30s' }],
        'timeout-2': [{ sleep_duration: '30s' }],
      },
    })
    const envelope = await handlerEnvelope(null)
    const runs = fakeRunsReader('ns_', new Map([[failedId, [fixtureRow({ status: 'FAILED', errorMessage: 'boom' })]]]))

    const outcomes = await waitForChildMessages(context, runs, envelope, childReplied, {
      where: { field: 'data.childEnvelopeId', envelopeIds: [repliedId, failedId, pendingId] },
      timeout: '30s',
    })

    expect(outcomes).toEqual([
      { envelopeId: repliedId, status: 'replied', envelope: reply },
      { envelopeId: failedId, status: 'failed', error: 'boom' },
      { envelopeId: pendingId, status: 'pending' },
    ])
  })

  it('rejects a matched reply from another tenant when scope was not given', async () => {
    const id = uuidv7()
    const reply = await createEnvelope(
      childReplied,
      { childEnvelopeId: id },
      { tenantId: 'a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a', source: 'sdk.test' },
    )
    const { context } = fakeDurableContext({ CREATE: { 'child-0': [asIncoming(reply)] } })
    const envelope = await handlerEnvelope('2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f30')
    const runs = fakeRunsReader('ns_', new Map())

    await expect(
      waitForChildMessages(context, runs, envelope, childReplied, {
        where: { field: 'data.childEnvelopeId', envelopeIds: [id] },
        timeout: '30s',
      }),
    ).rejects.toBeInstanceOf(EnvelopeRejectedError)
  })

  it('rejects a reply behind child-<i> that does not carry envelopeIds[i], so a misordered replay is not misattributed', async () => {
    const [id0, id1] = [uuidv7(), uuidv7()]
    // child-0's own key should pair with id0; this reply carries id1 instead.
    const reply = await createEnvelope(childReplied, { childEnvelopeId: id1 }, { tenantId: null, source: 'sdk.test' })
    const { context } = fakeDurableContext({ CREATE: { 'child-0': [asIncoming(reply)] } })
    const envelope = await handlerEnvelope(null)
    const runs = fakeRunsReader('ns_', new Map())

    await expect(
      waitForChildMessages(context, runs, envelope, childReplied, {
        where: { field: 'data.childEnvelopeId', envelopeIds: [id0, id1] },
        timeout: '30s',
      }),
    ).rejects.toThrow(new RegExp(`${id0}.*${id1}|${id1}.*${id0}`))
  })
})
