import { defineEvent, envelopeSchema } from '@kyuworks/schemas'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Queryable, QueryParam, QueryRows } from '../db/queryable.js'
import { EnvelopeRejectedError, ScheduleMessageUnknownError } from '../errors.js'
import { runScheduleTick } from './scheduleRunner.js'

const ticked = defineEvent({ name: 'kyu.schedule_test.ticked', version: 1, data: z.object({ n: z.number() }) })

function recordingDb() {
  const recordedParams: Array<readonly QueryParam[]> = []
  const db: Queryable = {
    query(_text: string, params: readonly QueryParam[]): Promise<QueryRows> {
      recordedParams.push(params)
      return Promise.resolve({ rows: [], rowCount: 1 })
    },
  }
  return { db, recordedParams }
}

describe('runScheduleTick', () => {
  it('rejects a tick whose input is not a schedule trigger', async () => {
    const { db } = recordingDb()

    await expect(runScheduleTick(db, [ticked], 'schedule-test', { not: 'a trigger' })).rejects.toThrow(
      EnvelopeRejectedError,
    )
  })

  it('rejects a tick naming a message the runner was not given', async () => {
    const { db } = recordingDb()
    const trigger = {
      kyuSchedule: 'nightly-report',
      name: ticked.name,
      version: ticked.version,
      tenantId: null,
      data: { n: 1 },
    }

    await expect(runScheduleTick(db, [], 'schedule-test', trigger)).rejects.toThrow(ScheduleMessageUnknownError)
  })

  it('two ticks publish two different envelope ids with the same tenant id', async () => {
    const { db, recordedParams } = recordingDb()
    const tenantId = '018f0000-0000-7000-8000-000000000009'
    const trigger = {
      kyuSchedule: 'nightly-report',
      name: ticked.name,
      version: ticked.version,
      tenantId,
      data: { n: 1 },
    }

    await runScheduleTick(db, [ticked], 'schedule-test', trigger)
    await runScheduleTick(db, [ticked], 'schedule-test', trigger)

    expect(recordedParams).toHaveLength(2)
    const envelopes = recordedParams.map((params) => envelopeSchema.parse(JSON.parse(z.string().parse(params[3]))))
    expect(envelopes[0]?.id).not.toBe(envelopes[1]?.id)
    expect(envelopes[0]?.tenantId).toBe(tenantId)
    expect(envelopes[1]?.tenantId).toBe(tenantId)
  })
})
