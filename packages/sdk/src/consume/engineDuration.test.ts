import { describe, expect, it } from 'vitest'
import type { Duration } from '../hatchet.js'
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
    ['2562047h', 9_223_369_200_000],
  ] as const)('reads %s as %d milliseconds', (value, milliseconds) => {
    expect(engineDurationMs(value as Extract<Duration, string>)).toBe(milliseconds)
  })

  it('refuses a value one hour past the engine ceiling', () => {
    expect(engineDurationMs('2562048h')).toBeUndefined()
  })
})
