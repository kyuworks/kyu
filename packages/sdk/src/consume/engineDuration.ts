// The engine's registration grammar (hatchet pkg/validator/validator.go DurationRegex at v0.107.0):
// one or more <number><unit> parts, unit ms, s, m or h, an optional fraction, no sign and no spaces.
const ENGINE_DURATION_PATTERN = /^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ms|s|m|h))+$/
const ENGINE_DURATION_PART = /(\d+(?:\.\d*)?|\.\d+)(ms|s|m|h)/g
// The engine stores the timeout with convert_duration_to_interval (sql/schema/v1-core.sql, v0.107.0), which is
// stricter than the validator: it raises on a number part over 15 characters and on a total over 9223372036
// seconds (below Go's limit). A workflow that registers with either loses every event of its type.
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
