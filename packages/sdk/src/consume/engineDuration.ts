import { DurationRejectedError } from '../errors.js'
import { KyuError } from '../hatchet.js'
import type { Duration } from '../hatchet.js'

// The engine's registration grammar (hatchet pkg/validator/validator.go DurationRegex at v0.107.0):
// one or more <number><unit> parts, unit ms, s, m or h, an optional fraction, no sign and no spaces.
const ENGINE_DURATION_PATTERN = /^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ms|s|m|h))+$/
const ENGINE_DURATION_PART = /(\d+(?:\.\d*)?|\.\d+)(ms|s|m|h)/g
// The engine stores every duration with convert_duration_to_interval (sql/schema/v1-core.sql, v0.107.0), which is
// stricter than the validator: it raises on a number part over 15 characters and on a total over 9223372036
// seconds (below Go's limit). With either, a scheduleTimeout loses every event of its type, an executionTimeout
// leaves every run queued, and a sleep or wait never wakes; it reads an unparsable sleep or wait as 5 minutes.
const ENGINE_DURATION_MAX_NUMBER_LENGTH = 15
const ENGINE_DURATION_MAX_MS = 9_223_372_036_000

type EngineDurationPart = `${number}${'ms' | 's' | 'm' | 'h'}`

/** One to four parts such as `'1.5s'`, `'500ms'` or `'1h30m'`; the engine reads longer chains too. */
export type EngineDuration =
  | EngineDurationPart
  | `${EngineDurationPart}${EngineDurationPart}`
  | `${EngineDurationPart}${EngineDurationPart}${EngineDurationPart}`
  | `${EngineDurationPart}${EngineDurationPart}${EngineDurationPart}${EngineDurationPart}`

function engineUnitMs(unit: string): number {
  switch (unit) {
    case 'h':
      return 3_600_000
    case 'm':
      return 60_000
    case 's':
      return 1_000
    default:
      return 1
  }
}

/** Whole milliseconds (half up) in a duration the engine stores, or undefined for one it refuses. */
export function engineDurationMs(value: EngineDuration): number | undefined {
  if (!ENGINE_DURATION_PATTERN.test(value)) return undefined
  let total = 0
  for (const [, amount, unit] of value.matchAll(ENGINE_DURATION_PART)) {
    if (amount === undefined || unit === undefined || amount.length > ENGINE_DURATION_MAX_NUMBER_LENGTH)
      return undefined
    total += Number(amount) * engineUnitMs(unit)
  }
  return total > ENGINE_DURATION_MAX_MS ? undefined : Math.round(total)
}

/** A duration the engine stores, typed as the client's string, with its whole milliseconds. */
export interface EngineDurationReading {
  duration: Extract<Duration, string>
  milliseconds: number
}

function toEngineDurationReading(value: EngineDuration): EngineDurationReading | undefined {
  const milliseconds = engineDurationMs(value)
  if (milliseconds === undefined) return undefined
  // The client types the string narrower than the engine reads and sends it unchanged
  // (workflow-proto resolveExecutionTimeout and resolveScheduleTimeout, conditions transformer durationToString).
  return { duration: value as Extract<Duration, string>, milliseconds }
}

function engineDurationRefusal(option: string, value: EngineDuration): string {
  return `${option} "${value}" is not a duration the engine reads: use numbers of at most 15 characters with a unit of ms, s, m or h, no sign or spaces, under 292 years, for example "5m", "1h30m" or "1.5s"`
}

/** Reads an option checked when the worker registers; a KyuError naming it for a value the engine would refuse. */
export function readEngineDuration(option: string, value: EngineDuration): EngineDurationReading {
  const reading = toEngineDurationReading(value)
  if (reading === undefined) throw new KyuError(engineDurationRefusal(option, value))
  return reading
}

/** Reads an option inside a running durable body; a DurationRejectedError for a refused value fails the run at once. */
export function readWaitDuration(option: string, value: EngineDuration): EngineDurationReading {
  const reading = toEngineDurationReading(value)
  if (reading === undefined) throw new DurationRejectedError(engineDurationRefusal(option, value))
  return reading
}
