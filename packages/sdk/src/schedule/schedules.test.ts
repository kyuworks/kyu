import { defineEvent } from '@kyuworks/schemas'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { KyuError } from '../hatchet.js'
import { ScheduleAlreadyExistsError } from '../errors.js'
import { createSchedules } from './schedules.js'
import type { SchedulesEngine } from './schedules.js'

const ticked = defineEvent({ name: 'kyu.schedule_test.ticked', version: 1, data: z.object({ n: z.number() }) })

function fakeEngine(rows: ReadonlyArray<{ name: string; cron: string }> = []) {
  const create = vi.fn().mockResolvedValue({})
  const del = vi.fn().mockResolvedValue(undefined)
  const list = vi.fn().mockResolvedValue({ rows })
  const engine: SchedulesEngine = { crons: { create, delete: del, list } }
  return { engine, create, del }
}

describe('createSchedules().create', () => {
  it('refuses a schedule name the engine would rewrite', async () => {
    const { engine, create } = fakeEngine()
    const schedules = createSchedules(engine)

    await expect(
      schedules.create({ name: 'Not Valid', cron: '* * * * *', definition: ticked, data: { n: 1 }, tenantId: null }),
    ).rejects.toThrow(KyuError)
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses a second schedule with a name that already exists', async () => {
    const { engine, create } = fakeEngine([{ name: 'nightly-report', cron: '0 9 * * *' }])
    const schedules = createSchedules(engine)

    await expect(
      schedules.create({
        name: 'nightly-report',
        cron: '0 9 * * *',
        definition: ticked,
        data: { n: 1 },
        tenantId: null,
      }),
    ).rejects.toThrow(ScheduleAlreadyExistsError)
    expect(create).not.toHaveBeenCalled()
  })

  it('sends the message name, version, tenant id and data as the cron input', async () => {
    const { engine, create } = fakeEngine()
    const schedules = createSchedules(engine)
    const tenantId = '018f0000-0000-7000-8000-000000000009'

    await schedules.create({ name: 'nightly-report', cron: '0 9 * * *', definition: ticked, data: { n: 5 }, tenantId })

    expect(create).toHaveBeenCalledWith('kyu-schedule-publisher', {
      name: 'nightly-report',
      expression: '0 9 * * *',
      input: { kyuSchedule: 'nightly-report', name: ticked.name, version: ticked.version, tenantId, data: { n: 5 } },
    })
  })
})

describe('createSchedules().remove', () => {
  it('returns false when no cron carries that name', async () => {
    const { engine, del } = fakeEngine([{ name: 'other-schedule', cron: '* * * * *' }])
    const schedules = createSchedules(engine)

    await expect(schedules.remove('nightly-report')).resolves.toBe(false)
    expect(del).not.toHaveBeenCalled()
  })

  it('deletes and returns true when a cron carries that name', async () => {
    const row = { name: 'nightly-report', cron: '0 9 * * *' }
    const { engine, del } = fakeEngine([row])
    const schedules = createSchedules(engine)

    await expect(schedules.remove('nightly-report')).resolves.toBe(true)
    expect(del).toHaveBeenCalledWith(row)
  })
})
