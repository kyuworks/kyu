import type { EngineDuration } from '../engineDuration.js'

// Each value was run on the local engine (v0.107.0) as an executionTimeout, a sleepFor and a waitFor timeout.
export const ACCEPTED_ENGINE_DURATIONS = [
  ['a fraction', '1.5s'],
  ['hours and minutes', '1h30m'],
  ['milliseconds', '500ms'],
  ['a repeated unit, which the engine adds up', '1s1s'],
  ['the 9223372036 second limit the engine stores', '2562047h47m16s'],
] as const satisfies ReadonlyArray<readonly [string, EngineDuration]>

// The engine refuses these at registration; as a sleep or a wait timeout it reads each as 5 minutes, silently.
export const UNREADABLE_ENGINE_DURATIONS = [
  ['a negative duration', '-30s'],
  ['an exponent', '1e3s'],
  ['a number with no unit', '90' as EngineDuration],
  ['an unknown unit', '5x' as EngineDuration],
  ['leading spaces', '  5m'],
  ['an empty string', '' as EngineDuration],
] as const satisfies ReadonlyArray<readonly [string, EngineDuration]>

// convert_duration_to_interval (sql/schema/v1-core.sql, v0.107.0) raises on these: as an executionTimeout the first
// three register and every run stays queued, and as a sleep or a wait timeout all four never wake.
export const UNSTORABLE_ENGINE_DURATIONS = [
  ['a number of 16 characters', '0000000000000001s'],
  ['a fraction of 18 characters', '1.0000000000000000s'],
  ['a total half a second past the 9223372036 second limit', '2562047h47m16.5s'],
  ['a total past the limit', '2562048h'],
] as const satisfies ReadonlyArray<readonly [string, EngineDuration]>

export const REFUSED_ENGINE_DURATIONS = [...UNREADABLE_ENGINE_DURATIONS, ...UNSTORABLE_ENGINE_DURATIONS]
