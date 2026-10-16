import { describe, expect, it } from 'vitest'
import { engineDurationMs } from './engineDuration.js'

// Milliseconds for values the local engine (v0.107.0) registered; the refusals are covered in subscribe.test.ts.
describe('engineDurationMs', () => {
  it.each([
    ['1.5s', 1_500],
    ['1h30m', 5_400_000],
    ['1m30.5s', 90_500],
    ['500ms', 500],
    ['1s1s', 2_000],
    ['.5m', 30_000],
    ['5.s', 5_000],
    ['0s', 0],
    ['0.0000001s', 0],
    ['000000000000001s', 1_000],
    ['2562047h47m16s', 9_223_372_036_000],
  ] as const)('reads %s as %d milliseconds', (value, milliseconds) => {
    expect(engineDurationMs(value)).toBe(milliseconds)
  })

  // Whole milliseconds, half up: a lookback of 1500.5ms starts 1501ms back.
  it.each([
    ['1500.4ms', 1_500],
    ['1500.5ms', 1_501],
  ] as const)('rounds %s to %d milliseconds', (value, milliseconds) => {
    expect(engineDurationMs(value)).toBe(milliseconds)
  })

  // convert_duration_to_interval (sql/schema/v1-core.sql, v0.107.0) raises on these, though the workflow registers.
  it.each([
    ['2562047h47m16.5s', 'a total one half second past the 9223372036 second limit'],
    ['2562048h', 'a total past the limit'],
    ['1.0000000000000000s', 'a number part of 18 characters'],
    ['0000000000000001s', 'a number part of 16 characters'],
  ] as const)('refuses %s, %s', (value, _why) => {
    expect(engineDurationMs(value)).toBeUndefined()
  })
})
