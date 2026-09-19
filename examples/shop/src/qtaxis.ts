import type { Qtaxis } from '@qtaxis/sdk'
import { createHatchetClient, createQtaxis } from '@qtaxis/sdk'
import type { ShopConfig } from './config.js'

// Every producer publishes under this source; ui/busTopology.ts reads it too,
// so the diagram's producer box can never name a source nothing uses.
export const SHOP_SOURCE = 'shop'

// One place builds the client, so migrate, relay, worker and the CLI all share the namespace rule.
export function createShopQtaxis(config: ShopConfig): Qtaxis {
  const hatchet = createHatchetClient({ namespace: config.namespace })
  return createQtaxis({ hatchet, source: SHOP_SOURCE })
}
