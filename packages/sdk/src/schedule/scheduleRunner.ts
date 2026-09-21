import type { MessageDefinition, Unparsed } from '@kyuworks/schemas'
import { createEnvelope } from '@kyuworks/schemas'
import type { Subscription } from '../consume/subscribe.js'
import type { Queryable } from '../db/queryable.js'
import { EnvelopeRejectedError, ScheduleMessageUnknownError } from '../errors.js'
import type { CreateTaskWorkflowOpts, HatchetClient, JsonObject } from '../hatchet.js'
import { publishEnvelope } from '../outbox/publish.js'
import { SCHEDULE_WORKFLOW_NAME, scheduleTriggerSchema } from './scheduleTrigger.js'

export interface ScheduleRunnerOptions {
  db: Queryable
  /** Every message a schedule created with `kyu.schedules.create` may name; a tick for a name outside this list is rejected. */
  definitions: readonly MessageDefinition[]
}

interface CreateScheduleRunnerOptions extends ScheduleRunnerOptions {
  source: string
}

function findDefinition(
  definitions: readonly MessageDefinition[],
  name: string,
  version: number,
): MessageDefinition | undefined {
  return definitions.find((definition) => definition.name === name && definition.version === version)
}

// The tick's own trust edge: the engine cron's payload, decoded once here.
// createEnvelope mints a fresh id on every call, so two ticks of the same
// schedule are never mistaken for a redelivery of each other.
export async function runScheduleTick(
  db: Queryable,
  definitions: readonly MessageDefinition[],
  source: string,
  input: Unparsed,
): Promise<void> {
  const parsed = scheduleTriggerSchema.safeParse(input)
  if (!parsed.success) {
    const summary = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new EnvelopeRejectedError(`schedule tick does not match the trigger schema: ${summary}`)
  }

  const trigger = parsed.data
  const definition = findDefinition(definitions, trigger.name, trigger.version)
  if (definition === undefined) throw new ScheduleMessageUnknownError(trigger.name, trigger.version)

  const envelope = await createEnvelope(definition, trigger.data, { tenantId: trigger.tenantId, source })
  await publishEnvelope(db, envelope)
}

/**
 * The one worker-registrable task every `kyu.schedules.create` cron fires.
 * `retries: 0`: a failed tick is the dead letter, never a second publish of
 * the same tick.
 */
export function createScheduleRunner(hatchet: HatchetClient, options: CreateScheduleRunnerOptions): Subscription {
  const taskOptions: CreateTaskWorkflowOpts<JsonObject, void> = {
    name: SCHEDULE_WORKFLOW_NAME,
    retries: 0,
    fn: (input: JsonObject) => runScheduleTick(options.db, options.definitions, options.source, input),
  }

  const workflow = hatchet.task<JsonObject, void>(taskOptions)

  return { name: SCHEDULE_WORKFLOW_NAME, kind: 'event', messageName: SCHEDULE_WORKFLOW_NAME, workflow }
}
