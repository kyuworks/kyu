import { describe, expect, it } from 'vitest'
import { assertNoDoubleEffect } from './assertions.js'

const ENVELOPE = '01a0c900-0000-7000-8000-000000000001'
const RUN = '01a0c901-0000-7000-8000-000000000001'

describe('assertNoDoubleEffect', () => {
  it('passes when every effect happened once', () => {
    expect(
      assertNoDoubleEffect({
        handlerRows: [{ handler: 'record-order', envelopeId: ENVELOPE, count: 1 }],
        workflowRunRows: [],
        notifyOutboxRows: [],
      }),
    ).toEqual([])
  })

  it('names the duplicated effect when one handler ran twice for one envelope', () => {
    const failures = assertNoDoubleEffect({
      handlerRows: [{ handler: 'record-order', envelopeId: ENVELOPE, count: 2 }],
      workflowRunRows: [],
      notifyOutboxRows: [],
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]?.detail).toContain('record-order')
    expect(failures[0]?.detail).toContain(ENVELOPE)
  })

  it('names a workflow notify published twice for one step', () => {
    const failures = assertNoDoubleEffect({
      handlerRows: [],
      workflowRunRows: [],
      notifyOutboxRows: [{ runId: RUN, stepId: 'nudge', count: 2 }],
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]?.detail).toContain('nudge')
  })
})
