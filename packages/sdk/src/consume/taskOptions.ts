import { KyuError, Priority, RateLimitDuration } from '../hatchet.js'
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
  // The engine reads a missing or negative limit as -1, which means "look the
  // key up in this tenant's registered static rate limits"; the SDK registers
  // none, so that limits nothing.
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
  if (options.priority !== undefined) taskOptions.defaultPriority = PRIORITY_CODE[options.priority]
}
