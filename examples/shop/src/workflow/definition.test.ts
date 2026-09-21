import { NonRetryableError } from '@kyuworks/sdk'
import { describe, expect, it } from 'vitest'
import { parseWorkflowDefinition, stepById } from './definition.js'

const EXAMPLE = {
  schemaVersion: 1,
  start: 'wait-a-bit',
  steps: [
    { id: 'wait-a-bit', kind: 'delay', input: { seconds: 3 }, next: 'shipped-yet' },
    {
      id: 'shipped-yet',
      kind: 'branch',
      input: { condition: 'order-shipped' },
      whenTrue: 'finish',
      whenFalse: 'settle',
    },
    { id: 'settle', kind: 'delay', input: { seconds: 5 }, next: 'nudge' },
    { id: 'nudge', kind: 'notify', input: { text: 'Order has not shipped yet.' }, next: 'finish' },
    { id: 'finish', kind: 'end' },
  ],
}

function delayStep(id: string, seconds: number, next: string) {
  return { id, kind: 'delay', input: { seconds }, next }
}

describe('parseWorkflowDefinition', () => {
  it('accepts the example definition', () => {
    const definition = parseWorkflowDefinition(EXAMPLE)
    expect(definition.steps).toHaveLength(5)
  })

  it('rejects a step whose next names a step id that does not exist', () => {
    const bad = {
      schemaVersion: 1,
      start: 'a',
      steps: [{ id: 'a', kind: 'delay', input: { seconds: 1 }, next: 'nowhere' }],
    }
    expect(() => parseWorkflowDefinition(bad)).toThrow(NonRetryableError)
  })

  it('rejects two steps with the same id', () => {
    const bad = {
      schemaVersion: 1,
      start: 'a',
      steps: [
        { id: 'a', kind: 'delay', input: { seconds: 1 }, next: 'a' },
        { id: 'a', kind: 'end' },
      ],
    }
    expect(() => parseWorkflowDefinition(bad)).toThrow(NonRetryableError)
  })

  it('rejects an unknown step kind', () => {
    const bad = { schemaVersion: 1, start: 'a', steps: [{ id: 'a', kind: 'loop', input: {} }] }
    expect(() => parseWorkflowDefinition(bad)).toThrow(NonRetryableError)
  })

  it('rejects zero steps', () => {
    const bad = { schemaVersion: 1, start: 'a', steps: [] }
    expect(() => parseWorkflowDefinition(bad)).toThrow(NonRetryableError)
  })

  it('rejects 21 steps', () => {
    const steps = Array.from({ length: 21 }, (_unused, index) =>
      index === 20
        ? { id: `s${String(index)}`, kind: 'end' }
        : delayStep(`s${String(index)}`, 1, `s${String(index + 1)}`),
    )
    expect(() => parseWorkflowDefinition({ schemaVersion: 1, start: 's0', steps })).toThrow(NonRetryableError)
  })

  it('rejects a delay of 0 seconds', () => {
    const bad = { schemaVersion: 1, start: 'a', steps: [delayStep('a', 0, 'a')] }
    expect(() => parseWorkflowDefinition(bad)).toThrow(NonRetryableError)
  })

  it('accepts a delay of exactly 600 seconds', () => {
    const definition = parseWorkflowDefinition({
      schemaVersion: 1,
      start: 'a',
      steps: [delayStep('a', 600, 'b'), { id: 'b', kind: 'end' }],
    })
    expect(definition.steps).toHaveLength(2)
  })

  it('rejects a delay of 601 seconds', () => {
    const bad = { schemaVersion: 1, start: 'a', steps: [delayStep('a', 601, 'a')] }
    expect(() => parseWorkflowDefinition(bad)).toThrow(NonRetryableError)
  })

  it('accepts a total delay of exactly 3000 seconds, split across steps under the 600s-per-step cap (#113)', () => {
    const definition = parseWorkflowDefinition({
      schemaVersion: 1,
      start: 'a',
      steps: [
        delayStep('a', 600, 'b'),
        delayStep('b', 600, 'c'),
        delayStep('c', 600, 'd'),
        delayStep('d', 600, 'e'),
        delayStep('e', 600, 'f'),
        { id: 'f', kind: 'end' },
      ],
    })
    expect(definition.steps).toHaveLength(6)
  })

  // Acyclic on purpose: every step reaches "end" through a single forward
  // path, so this is rejected by the sum cap alone, not by the cycle check.
  it('rejects a total delay of 3001 seconds (#113)', () => {
    const bad = {
      schemaVersion: 1,
      start: 'a',
      steps: [
        delayStep('a', 600, 'b'),
        delayStep('b', 600, 'c'),
        delayStep('c', 600, 'd'),
        delayStep('d', 600, 'e'),
        delayStep('e', 600, 'f'),
        delayStep('f', 1, 'g'),
        { id: 'g', kind: 'end' },
      ],
    }
    expect(() => parseWorkflowDefinition(bad)).toThrow(NonRetryableError)
  })

  // Red proof: a two-step cycle with a total delay well under the 3000s cap.
  // The sum check alone would accept this; only a walk from `start` that
  // rejects a revisited step catches it.
  it('rejects a two-step cycle even when the total delay is under the cap', () => {
    const bad = {
      schemaVersion: 1,
      start: 'a',
      steps: [delayStep('a', 1, 'b'), delayStep('b', 1, 'a')],
    }
    expect(() => parseWorkflowDefinition(bad)).toThrow(NonRetryableError)
  })

  it('rejects a step unreachable from start', () => {
    const bad = {
      schemaVersion: 1,
      start: 'a',
      steps: [
        { id: 'a', kind: 'end' },
        { id: 'b', kind: 'end' },
      ],
    }
    expect(() => parseWorkflowDefinition(bad)).toThrow(NonRetryableError)
  })

  it('rejects a start that does not name an existing step', () => {
    const bad = { schemaVersion: 1, start: 'missing', steps: [{ id: 'a', kind: 'end' }] }
    expect(() => parseWorkflowDefinition(bad)).toThrow(NonRetryableError)
  })
})

describe('stepById', () => {
  it('returns the step with the matching id', () => {
    const definition = parseWorkflowDefinition(EXAMPLE)
    expect(stepById(definition, 'nudge').kind).toBe('notify')
  })

  it('throws NonRetryableError when no step has that id', () => {
    const definition = parseWorkflowDefinition(EXAMPLE)
    expect(() => stepById(definition, 'missing')).toThrow(NonRetryableError)
  })
})
