import { ConcurrencyLimitStrategy } from '../hatchet.js'
import type { Concurrency } from '../hatchet.js'

export interface ConcurrencyOption {
  key: string
  maxRuns?: number
  strategy?: 'fifo' | 'cancel_in_progress' | 'cancel_newest'
}

// No strategy given defaults to fifo: a concurrency key means ordering, not
// coalescing (CONTEXT.md: "maxRuns: 1 per key gives FIFO per key").
function toLimitStrategy(strategy: NonNullable<ConcurrencyOption['strategy']>): ConcurrencyLimitStrategy {
  switch (strategy) {
    case 'fifo':
      return ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN
    case 'cancel_in_progress':
      return ConcurrencyLimitStrategy.CANCEL_IN_PROGRESS
    case 'cancel_newest':
      return ConcurrencyLimitStrategy.CANCEL_NEWEST
  }
}

export function toHatchetConcurrency(option: ConcurrencyOption): Concurrency {
  return {
    expression: option.key,
    maxRuns: option.maxRuns ?? 1,
    limitStrategy: toLimitStrategy(option.strategy ?? 'fifo'),
  }
}
