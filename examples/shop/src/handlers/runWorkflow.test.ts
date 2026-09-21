import { describe, expect, it } from 'vitest'
import { MAX_WORKFLOW_STEPS } from '../workflow/definition.js'
import { DELAY_HANDOFF_SECONDS } from './runWorkflow.js'

// run-workflow fixes executionTimeout at 1h (3600s). Only delays below the
// hand-off threshold sleep in-process, so the worst run sleeps for this product.
describe('the in-process sleep budget', () => {
  it('stays under run-workflow’s 1h execution timeout', () => {
    expect(MAX_WORKFLOW_STEPS * DELAY_HANDOFF_SECONDS).toBeLessThanOrEqual(3600)
  })
})
