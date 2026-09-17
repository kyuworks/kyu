import { Priority, RateLimitDuration } from '../hatchet.js'
import type { Concurrency, CreateTaskWorkflowOpts, Duration, JsonObject } from '../hatchet.js'
import { toHatchetConcurrency } from './concurrency.js'
import type { ConcurrencyOption } from './concurrency.js'

export type RateLimitOption =
  | { staticKey: string; units?: number }
  | {
      dynamicKey: string
      units?: number
      limit: number
      duration: 'SECOND' | 'MINUTE' | 'HOUR' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'
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

const RATE_LIMIT_DURATION = {
  SECOND: RateLimitDuration.SECOND,
  MINUTE: RateLimitDuration.MINUTE,
  HOUR: RateLimitDuration.HOUR,
  DAY: RateLimitDuration.DAY,
  WEEK: RateLimitDuration.WEEK,
  MONTH: RateLimitDuration.MONTH,
  YEAR: RateLimitDuration.YEAR,
} satisfies Record<Extract<RateLimitOption, { dynamicKey: string }>['duration'], RateLimitDuration>

const PRIORITY_CODE = { low: Priority.LOW, medium: Priority.MEDIUM, high: Priority.HIGH } as const

export function toHatchetRateLimit(option: RateLimitOption): HatchetRateLimitInput {
  if ('staticKey' in option) {
    return { staticKey: option.staticKey, units: option.units ?? 1 }
  }
  return {
    dynamicKey: option.dynamicKey,
    units: option.units ?? 1,
    limit: option.limit,
    duration: RATE_LIMIT_DURATION[option.duration],
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
