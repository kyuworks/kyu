import type { MessageDefinition, MessageInput, MessageSchema } from '@kyuworks/schemas'
import { validateStandard } from '@kyuworks/schemas'
import { ScheduleAlreadyExistsError } from '../errors.js'
import type { HatchetClient } from '../hatchet.js'
import { SCHEDULE_WORKFLOW_NAME, assertScheduleName } from './scheduleTrigger.js'

type CronRow = Awaited<ReturnType<HatchetClient['crons']['create']>>

// Narrowed to what this file actually needs, so the unit test's fake is a plain object.
export interface SchedulesEngine {
  crons: Pick<HatchetClient['crons'], 'create' | 'delete' | 'list'>
}

export interface Schedule {
  name: string
  cron: string
}

export interface CreateScheduleOptions<S extends MessageSchema> {
  /** Lowercase letters, digits, `-` or `_`, starting with a letter. Cron names are bus-tenant-global: unique across every consumer. */
  name: string
  /** A standard five-field cron expression, e.g. `'0 9 * * *'`. */
  cron: string
  definition: MessageDefinition<S>
  data: MessageInput<MessageDefinition<S>>
  tenantId: string | null
}

export interface KyuSchedules {
  /** Refuses a name already in use — `remove` it first to change its cron or message. */
  create<S extends MessageSchema>(options: CreateScheduleOptions<S>): Promise<Schedule>
  /** `false` when no schedule carries that name. */
  remove(name: string): Promise<boolean>
  list(): Promise<readonly Schedule[]>
}

async function findByName(hatchet: SchedulesEngine, name: string): Promise<CronRow | undefined> {
  const result = await hatchet.crons.list({ workflow: SCHEDULE_WORKFLOW_NAME, cronName: name })
  return (result.rows ?? []).find((row) => row.name === name)
}

export function createSchedules(hatchet: SchedulesEngine): KyuSchedules {
  return {
    async create<S extends MessageSchema>(options: CreateScheduleOptions<S>): Promise<Schedule> {
      assertScheduleName(options.name)
      const existing = await findByName(hatchet, options.name)
      if (existing !== undefined) throw new ScheduleAlreadyExistsError(options.name)

      // Validated once here, at the schedule's own trust edge, so a bad
      // payload fails the call instead of dead-lettering on every future tick.
      const data = await validateStandard(options.definition.data, options.data)
      await hatchet.crons.create(SCHEDULE_WORKFLOW_NAME, {
        name: options.name,
        expression: options.cron,
        input: {
          kyuSchedule: options.name,
          name: options.definition.name,
          version: options.definition.version,
          tenantId: options.tenantId,
          data,
        },
      })
      return { name: options.name, cron: options.cron }
    },
    async remove(name: string): Promise<boolean> {
      const existing = await findByName(hatchet, name)
      if (existing === undefined) return false
      await hatchet.crons.delete(existing)
      return true
    },
    async list(): Promise<readonly Schedule[]> {
      const result = await hatchet.crons.list({ workflow: SCHEDULE_WORKFLOW_NAME })
      const schedules: Schedule[] = []
      for (const row of result.rows ?? []) {
        if (row.name !== undefined) schedules.push({ name: row.name, cron: row.cron })
      }
      return schedules
    },
  }
}
