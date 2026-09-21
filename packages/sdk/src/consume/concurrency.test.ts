import { describe, expect, it } from 'vitest'
import { ConcurrencyLimitStrategy } from '../hatchet.js'
import { TENANT_CONCURRENCY_KEY, toHatchetConcurrency } from './concurrency.js'

describe('toHatchetConcurrency', () => {
  it('maps fifo to GROUP_ROUND_ROBIN', () => {
    expect(toHatchetConcurrency({ key: 'input.data.orderId', strategy: 'fifo' })).toEqual({
      expression: 'input.data.orderId',
      maxRuns: 1,
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    })
  })

  it('maps cancel_in_progress to CANCEL_IN_PROGRESS', () => {
    expect(toHatchetConcurrency({ key: 'input.data.orderId', strategy: 'cancel_in_progress' })).toEqual({
      expression: 'input.data.orderId',
      maxRuns: 1,
      limitStrategy: ConcurrencyLimitStrategy.CANCEL_IN_PROGRESS,
    })
  })

  it('maps cancel_newest to CANCEL_NEWEST', () => {
    expect(toHatchetConcurrency({ key: 'input.data.orderId', strategy: 'cancel_newest' })).toEqual({
      expression: 'input.data.orderId',
      maxRuns: 1,
      limitStrategy: ConcurrencyLimitStrategy.CANCEL_NEWEST,
    })
  })

  it('defaults maxRuns to 1 and strategy to fifo', () => {
    expect(toHatchetConcurrency({ key: 'input.data.orderId' })).toEqual({
      expression: 'input.data.orderId',
      maxRuns: 1,
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    })
  })

  it('carries an explicit maxRuns through', () => {
    expect(toHatchetConcurrency({ key: 'input.data.orderId', maxRuns: 5, strategy: 'fifo' })).toEqual({
      expression: 'input.data.orderId',
      maxRuns: 5,
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    })
  })

  it('maps round-robin to GROUP_ROUND_ROBIN on the tenant key', () => {
    expect(toHatchetConcurrency({ key: TENANT_CONCURRENCY_KEY, maxRuns: 1, strategy: 'round-robin' })).toEqual({
      expression: 'input.tenantId',
      maxRuns: 1,
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    })
  })
})
