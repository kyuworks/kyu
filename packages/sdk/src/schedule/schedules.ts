import type { MessageDefinition, MessageInput, MessageSchema } from '@kyuworks/schemas'
import { validateStandard } from '@kyuworks/schemas'
import { ScheduleAlreadyExistsError } from '../errors.js'
import type { HatchetClient } from '../hatchet.js'
import { KyuError } from '../hatchet.js'
import { SCHEDULE_WORKFLOW_NAME, assertScheduleName, scheduleTriggerSchema } from './scheduleTrigger.js'

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
  /** Lowercase letters, digits, `-` or `_`, starting with a letter. A cron hangs off this client's namespaced runner workflow, so its name is unique within this client's namespace, not across every consumer. */
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

// One cron client per namespace cannot plausibly carry more than this; mirrors
// consume/runOutcomes.ts's RUN_PAGE_LIMIT.
const SCHEDULE_PAGE_LIMIT = 100

const SCHEDULE_RUNNER_NOT_REGISTERED_MESSAGE =
  'schedules need a running worker with kyu.scheduleRunner(...) registered before create, remove or list'

// crons.list resolves `workflow` to a workflow id first (vendored crons.js:116,
// via workflows.js's `get`) and throws this bare Error when no worker has
// registered SCHEDULE_WORKFLOW_NAME on this namespace yet.
const WORKFLOW_NOT_FOUND_PATTERN = /^Workflow with name .* not found$/

async function listCronRows(hatchet: SchedulesEngine, cronName?: string): Promise<readonly CronRow[]> {
  const query: Parameters<SchedulesEngine['crons']['list']>[0] = {
    workflow: SCHEDULE_WORKFLOW_NAME,
    limit: SCHEDULE_PAGE_LIMIT,
  }
  if (cronName !== undefined) query.cronName = cronName

  let result: Awaited<ReturnType<SchedulesEngine['crons']['list']>>
  try {
    result = await hatchet.crons.list(query)
  } catch (cause) {
    if (cause instanceof Error && WORKFLOW_NOT_FOUND_PATTERN.test(cause.message)) {
      throw new KyuError(SCHEDULE_RUNNER_NOT_REGISTERED_MESSAGE)
    }
    throw cause
  }

  if ((result.pagination?.num_pages ?? 1) > 1) {
    throw new KyuError(
      `schedules: more than ${SCHEDULE_PAGE_LIMIT} crons are registered under ${SCHEDULE_WORKFLOW_NAME}; remove unused schedules first`,
    )
  }
  return result.rows ?? []
}

async function rowsNamed(hatchet: SchedulesEngine, name: string): Promise<readonly CronRow[]> {
  const rows = await listCronRows(hatchet, name)
  return rows.filter((row) => row.name === name)
}

export function createSchedules(hatchet: SchedulesEngine): KyuSchedules {
  return {
    async create<S extends MessageSchema>(options: CreateScheduleOptions<S>): Promise<Schedule> {
      assertScheduleName(options.name)
      const existing = await rowsNamed(hatchet, options.name)
      if (existing.length > 0) throw new ScheduleAlreadyExistsError(options.name)

      // Validated once here, at the schedule's own trust edge, so a bad
      // payload fails the call instead of dead-lettering on every future tick.
      const data = await validateStandard(options.definition.data, options.data)

      // Same schema the tick parses on arrival: a bad tenant id (or name/
      // version) fails create() instead of registering a cron that
      // dead-letters on every future tick.
      const parsed = scheduleTriggerSchema.safeParse({
        kyuSchedule: options.name,
        name: options.definition.name,
        version: options.definition.version,
        tenantId: options.tenantId,
        data,
      })
      if (!parsed.success) {
        const summary = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
        throw new KyuError(`schedule input does not match the trigger schema: ${summary}`)
      }

      await hatchet.crons.create(SCHEDULE_WORKFLOW_NAME, {
        name: options.name,
        expression: options.cron,
        input: parsed.data,
      })
      return { name: options.name, cron: options.cron }
    },
    async remove(name: string): Promise<boolean> {
      const rows = await rowsNamed(hatchet, name)
      if (rows.length === 0) return false
      // The engine allows more than one cron with the same name; remove all
      // of them so a stray duplicate cannot keep ticking after `remove`.
      for (const row of rows) {
        await hatchet.crons.delete(row)
      }
      return true
    },
    async list(): Promise<readonly Schedule[]> {
      const rows = await listCronRows(hatchet)
      const schedules: Schedule[] = []
      for (const row of rows) {
        if (row.name !== undefined) schedules.push({ name: row.name, cron: row.cron })
      }
      return schedules
    },
  }
}
