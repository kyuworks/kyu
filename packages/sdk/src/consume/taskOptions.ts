import { KyuError, Priority, RateLimitDuration, durationToMs } from '../hatchet.js'
import type { Concurrency, CreateTaskWorkflowOpts, Duration, JsonObject } from '../hatchet.js'
import { toHatchetConcurrency } from './concurrency.js'
import type { ConcurrencyOption } from './concurrency.js'

/**
 * An engine-side rate limit on a subscription. `key` is a CEL expression over
 * the event, the same language a concurrency key uses: a constant such as
 * `"'marketplace'"` gives every run one bucket, and `"'marketplace:' +
 * additional_metadata.tenantId"` gives each business tenant its own. A run
 * that would pass the limit is queued and starts in a later period; the
 * engine never fails it.
 */
export interface RateLimitOption {
  key: string
  limit: number
  period: 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'
}

// subscribe() and durable() both build one of these; the Omit works for both
// because neither field type depends on the handler's fn signature.
export type SharedTaskFields = Omit<CreateTaskWorkflowOpts<JsonObject, void>, 'name' | 'fn' | 'onEvents'>

type HatchetRateLimitInput = NonNullable<SharedTaskFields['rateLimits']>[number]

export interface SharedTaskOptions {
  concurrency?: ConcurrencyOption | ConcurrencyOption[]
  retries?: number
  backoff?: { factor?: number; maxSeconds?: number }
  rateLimits?: RateLimitOption[]
  executionTimeout?: Extract<Duration, string>
  /**
   * How long a run may wait in the queue for a free slot. The engine fails a
   * run that waits longer without ever starting it; its own default is 5
   * minutes, which the SDK leaves in place.
   */
  scheduleTimeout?: Extract<Duration, string>
  priority?: 'low' | 'medium' | 'high'
}

// The engine registers a workflow as the namespace plus this name, lowercased (Hatchet SDK's
// normalizeWorkflowDefinition); anything it would change reads back as a name the caller never chose.
// Exported for schedule/scheduleTrigger.ts: a cron name is never namespaced by the engine, but the
// same character class keeps it registrable and legible in the dashboard.
export const SUBSCRIPTION_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/

export function assertSubscriptionName(name: string): void {
  if (!SUBSCRIPTION_NAME_PATTERN.test(name)) {
    throw new KyuError(
      `subscription name "${name}" is not registrable: use lowercase letters, digits, "-" or "_", starting with a letter`,
    )
  }
}

const RATE_LIMIT_DURATION = {
  second: RateLimitDuration.SECOND,
  minute: RateLimitDuration.MINUTE,
  hour: RateLimitDuration.HOUR,
  day: RateLimitDuration.DAY,
  week: RateLimitDuration.WEEK,
  month: RateLimitDuration.MONTH,
  year: RateLimitDuration.YEAR,
} satisfies Record<RateLimitOption['period'], RateLimitDuration>

const PRIORITY_CODE = { low: Priority.LOW, medium: Priority.MEDIUM, high: Priority.HIGH } as const

export function toHatchetRateLimit(option: RateLimitOption): HatchetRateLimitInput {
  if (option.key.trim() === '') {
    throw new KyuError(`rate limit key is empty: give a CEL expression, for example "'marketplace'"`)
  }
  // The engine reads a missing limit as -1, which means "look the key up in
  // this tenant's registered static rate limits"; the SDK registers none, so
  // the engine holds every run queued for ever. (A negative limit never
  // reaches the engine: the check below refuses it first.)
  if (!Number.isInteger(option.limit) || option.limit < 1) {
    throw new KyuError(`rate limit ${option.key} needs a whole number of runs above zero, got ${option.limit}`)
  }
  return {
    dynamicKey: option.key,
    units: 1,
    limit: option.limit,
    duration: RATE_LIMIT_DURATION[option.period],
  }
}

// The Duration string type still admits '0s', '1.5s' and '-30s'. Proved on the
// local engine: '0s' fails every queued run in about 20ms, with no start time
// and no error message, so a bad value here dead-letters a whole subscription.
function assertScheduleTimeout(value: Extract<Duration, string>): void {
  let milliseconds: number
  try {
    milliseconds = durationToMs(value)
  } catch (cause) {
    throw new KyuError(
      `scheduleTimeout "${value}" is not a duration the engine reads: use hours, minutes and seconds, for example "5m" or "1h30m"`,
      { cause: cause instanceof Error ? cause : new Error(String(cause)) },
    )
  }
  if (milliseconds <= 0) {
    throw new KyuError(
      value.trim() === ''
        ? `scheduleTimeout is empty: every run would fail before it started`
        : `scheduleTimeout "${value}" is zero: every run would fail before it started`,
    )
  }
}

function toConcurrencyList(
  option: ConcurrencyOption | ConcurrencyOption[] | undefined,
): Concurrency | Concurrency[] | undefined {
  if (option === undefined) return undefined
  return Array.isArray(option) ? option.map(toHatchetConcurrency) : toHatchetConcurrency(option)
}

/** Maps the fields subscribe() and durable() share onto the engine's task options, in place. */
export function applySharedTaskOptions(taskOptions: SharedTaskFields, options: SharedTaskOptions): void {
  const concurrency = toConcurrencyList(options.concurrency)
  if (concurrency !== undefined) taskOptions.concurrency = concurrency
  if (options.retries !== undefined) taskOptions.retries = options.retries
  if (options.backoff !== undefined) taskOptions.backoff = options.backoff
  if (options.rateLimits !== undefined) taskOptions.rateLimits = options.rateLimits.map(toHatchetRateLimit)
  if (options.executionTimeout !== undefined) taskOptions.executionTimeout = options.executionTimeout
  if (options.scheduleTimeout !== undefined) {
    assertScheduleTimeout(options.scheduleTimeout)
    taskOptions.scheduleTimeout = options.scheduleTimeout
  }
  if (options.priority !== undefined) taskOptions.defaultPriority = PRIORITY_CODE[options.priority]
}
