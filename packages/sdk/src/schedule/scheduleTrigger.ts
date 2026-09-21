import { messageNameSchema, messageVersionSchema } from '@kyuworks/schemas'
import { z } from 'zod'
import { SUBSCRIPTION_NAME_PATTERN } from '../consume/taskOptions.js'
import { KyuError } from '../hatchet.js'

/** The one internal task every schedule tick runs, whatever message it goes on to publish. */
export const SCHEDULE_WORKFLOW_NAME = 'kyu-schedule-publisher'

// A cron's own name is not namespaced by the engine (crons.create sends it
// unchanged), so the same character class as a subscription name keeps it
// registrable and legible in the dashboard.
export function assertScheduleName(name: string): void {
  if (!SUBSCRIPTION_NAME_PATTERN.test(name)) {
    throw new KyuError(
      `schedule name "${name}" is not registrable: use lowercase letters, digits, "-" or "_", starting with a letter`,
    )
  }
}

// The engine cron's `input`, decoded once at the tick's trust edge. Carries
// its own message name/version rather than relying on the workflow's — one
// runner task serves every schedule, whatever message it publishes.
export const scheduleTriggerSchema = z.object({
  kyuSchedule: z.string(),
  name: messageNameSchema,
  version: messageVersionSchema,
  tenantId: z.uuid().nullable(),
  data: z.record(z.string(), z.json()),
})

export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>
