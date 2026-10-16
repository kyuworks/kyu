import type { Duration } from '../hatchet.js'

// The engine's registration grammar (hatchet pkg/validator/validator.go DurationRegex at v0.107.0):
// one or more <number><unit> parts, unit ms, s, m or h, an optional fraction, no sign and no spaces.
const ENGINE_DURATION_PATTERN = /^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ms|s|m|h))+$/
const ENGINE_DURATION_PART = /(\d+(?:\.\d*)?|\.\d+)(ms|s|m|h)/g
// Go's time.Duration ceiling, 2^63-1 nanoseconds: the engine refuses a longer value at registration.
const ENGINE_DURATION_MAX_MS = 9_223_372_036_854

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

/** Whole milliseconds in a duration the engine registers, or undefined for one it refuses. */
export function engineDurationMs(value: Extract<Duration, string>): number | undefined {
  if (!ENGINE_DURATION_PATTERN.test(value)) return undefined
  let total = 0
  for (const [, amount, unit] of value.matchAll(ENGINE_DURATION_PART)) {
    // The pattern above guarantees every part has a unit.
    total += Number(amount) * engineUnitMs(unit ?? 'ms')
  }
  return total > ENGINE_DURATION_MAX_MS ? undefined : Math.round(total)
}
