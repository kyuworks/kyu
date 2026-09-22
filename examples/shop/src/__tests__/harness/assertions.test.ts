import { describe, expect, it } from 'vitest'
import { assertNoDoubleEffect, assertNoFailedRun } from './assertions.js'

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

describe('assertNoFailedRun', () => {
  it('passes when every run outcome is not failed', () => {
    expect(
      assertNoFailedRun([
        {
          envelopeId: ENVELOPE,
          outcomes: [
            { subscription: 'record-order', status: 'completed', attempts: 1, runId: RUN, createdAt: new Date() },
          ],
        },
      ]),
    ).toEqual([])
  })

  it('names the envelope id and the error when one run failed', () => {
    const failures = assertNoFailedRun([
      {
        envelopeId: ENVELOPE,
        outcomes: [
          {
            subscription: 'record-order',
            status: 'failed',
            attempts: 2,
            runId: RUN,
            createdAt: new Date(),
            error: 'duplicate key value violates unique constraint "shop_handler_log_once_idx"',
          },
        ],
      },
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0]?.check).toBe('no-failed-run')
    expect(failures[0]?.detail).toContain(ENVELOPE)
    expect(failures[0]?.detail).toContain('shop_handler_log_once_idx')
  })
})
