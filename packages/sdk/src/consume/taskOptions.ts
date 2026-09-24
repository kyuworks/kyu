import { z } from 'zod'
import { KyuError, Priority, RateLimitDuration, durationToMs } from '../hatchet.js'
import type { Concurrency, CreateTaskWorkflowOpts, Duration, HatchetClient, JsonObject } from '../hatchet.js'
import { celPayloadPath } from './celPath.js'
import { TENANT_CONCURRENCY_KEY, toHatchetConcurrency } from './concurrency.js'
import type { ConcurrencyOption } from './concurrency.js'

/**
 * An engine-side rate limit on a subscription. `key` is a CEL expression over
 * the event, the same language a concurrency key uses: a constant such as
 * `"'marketplace'"` gives every run one bucket, and `"'marketplace:' +
 * additional_metadata.tenantId"` gives each business tenant its own. A run
 * that would pass the limit is queued and starts in a later period; the
 * engine never fails it. To count per tenant, correlation or data field in
 * product units, use `rateLimit`.
 */
export interface RateLimitOption {
  key: string
  limit: number
  period: 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'
}

export type RateLimitWindow = RateLimitOption['period']

/**
 * A rate limit in product units: `{ per: 'tenant', limit: 100, window: 'hour' }`
 * starts at most 100 runs per business tenant per hour. `field` is a dotted
 * path relative to the payload, as in `waitFor`'s `where.field`.
 */
export type SubscriptionRateLimitOption =
  | { per: 'tenant'; limit: number; window: RateLimitWindow }
  | { per: 'correlation'; limit: number; window: RateLimitWindow }
  | { per: 'field'; field: string; limit: number; window: RateLimitWindow }

// subscribe() and durable() both build one of these; the Omit works for both
// because neither field type depends on the handler's fn signature.
export type SharedTaskFields = Omit<CreateTaskWorkflowOpts<JsonObject, void>, 'name' | 'fn' | 'onEvents'>

type HatchetRateLimitInput = NonNullable<SharedTaskFields['rateLimits']>[number]

export interface SharedTaskOptions {
  concurrency?: ConcurrencyOption | ConcurrencyOption[]
  retries?: number
  backoff?: { factor?: number; maxSeconds?: number }
  rateLimits?: RateLimitOption[]
  /** Counted in a bucket of this subscription's own (namespace plus name). Use `rateLimits` to share a bucket; never both. */
  rateLimit?: SubscriptionRateLimitOption
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

const rateLimitCountSchema = z.number().int().positive()
const rateLimitWindowSchema = z.enum(['second', 'minute', 'hour', 'day', 'week', 'month', 'year'])
const subscriptionRateLimitSchema = z.discriminatedUnion('per', [
  z.strictObject({ per: z.literal('tenant'), limit: rateLimitCountSchema, window: rateLimitWindowSchema }),
  z.strictObject({ per: z.literal('correlation'), limit: rateLimitCountSchema, window: rateLimitWindowSchema }),
  z.strictObject({
    per: z.literal('field'),
    field: z.string(),
    limit: rateLimitCountSchema,
    window: rateLimitWindowSchema,
  }),
]) satisfies z.ZodType<SubscriptionRateLimitOption>

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
  return toEngineRateLimit(option)
}

function toEngineRateLimit(option: RateLimitOption): HatchetRateLimitInput {
  return { dynamicKey: option.key, units: 1, limit: option.limit, duration: RATE_LIMIT_DURATION[option.period] }
}

function rateLimitSubject(option: SubscriptionRateLimitOption): string {
  switch (option.per) {
    case 'tenant':
      return TENANT_CONCURRENCY_KEY
    case 'correlation':
      return 'input.correlationId'
    case 'field':
      return `string(${celPayloadPath('rateLimit.field', option.field)})`
  }
}

/** Resolves `rateLimit` to the explicit form, keyed under `bucket`. */
function resolveSubscriptionRateLimit(bucket: string, option: SubscriptionRateLimitOption): RateLimitOption {
  const parsed = subscriptionRateLimitSchema.safeParse(option)
  if (!parsed.success) {
    throw new KyuError(`rateLimit on subscription ${bucket} is not valid: ${z.prettifyError(parsed.error)}`)
  }
  const { limit, window } = parsed.data
  return { key: `${JSON.stringify(`${bucket}:`)} + ${rateLimitSubject(parsed.data)}`, limit, period: window }
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
      value.length === 0
        ? 'scheduleTimeout is empty: every run would fail before it started'
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

/**
 * Maps the fields subscribe() and durable() share onto the engine's task options, in place.
 * `hatchet` is read only for `rateLimit`'s bucket.
 */
export function applySharedTaskOptions(
  taskOptions: SharedTaskFields,
  options: SharedTaskOptions & { name: string },
  hatchet: Pick<HatchetClient, 'config'>,
): void {
  const concurrency = toConcurrencyList(options.concurrency)
  if (concurrency !== undefined) taskOptions.concurrency = concurrency
  if (options.retries !== undefined) taskOptions.retries = options.retries
  if (options.backoff !== undefined) taskOptions.backoff = options.backoff
  if (options.rateLimit !== undefined && options.rateLimits !== undefined) {
    throw new KyuError(`subscription ${options.name} sets both rateLimit and rateLimits: use one form`)
  }
  if (options.rateLimits !== undefined) taskOptions.rateLimits = options.rateLimits.map(toHatchetRateLimit)
  if (options.rateLimit !== undefined) {
    const bucket = `${hatchet.config.namespace ?? ''}${options.name}`
    taskOptions.rateLimits = [toEngineRateLimit(resolveSubscriptionRateLimit(bucket, options.rateLimit))]
  }
  if (options.executionTimeout !== undefined) taskOptions.executionTimeout = options.executionTimeout
  if (options.scheduleTimeout !== undefined) {
    assertScheduleTimeout(options.scheduleTimeout)
    taskOptions.scheduleTimeout = options.scheduleTimeout
  }
  if (options.priority !== undefined) taskOptions.defaultPriority = PRIORITY_CODE[options.priority]
}
