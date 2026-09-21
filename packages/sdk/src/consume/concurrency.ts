import { ConcurrencyLimitStrategy } from '../hatchet.js'
import type { Concurrency } from '../hatchet.js'

export interface ConcurrencyOption {
  key: string
  maxRuns?: number
  strategy?: 'fifo' | 'round-robin' | 'cancel_in_progress' | 'cancel_newest'
}

/** CEL path to the business tenant id: the relay pushes the whole envelope as the event payload, so `tenantId` is a top-level field of `input`. */
export const TENANT_CONCURRENCY_KEY = 'input.tenantId'

// The engine has one queueing strategy: FIFO inside a key group, round robin
// across groups (protoc/v1/workflows.d.ts — there is no FIFO member). `fifo`
// names it for a per-entity key, `round-robin` for a key that groups a whole
// business tenant; no strategy means `fifo`, because a concurrency key means
// ordering, not coalescing (CONTEXT.md).
function toLimitStrategy(strategy: NonNullable<ConcurrencyOption['strategy']>): ConcurrencyLimitStrategy {
  switch (strategy) {
    case 'fifo':
    case 'round-robin':
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
