import type { Kyu, Publisher } from '@kyuworks/sdk'
import { createHatchetClient, createKyu, createPublisher } from '@kyuworks/sdk'
import type { ShopConfig } from './config.js'

// Every producer publishes under this source; ui/busTopology.ts reads it too,
// so the diagram's producer box can never name a source nothing uses.
export const SHOP_SOURCE = 'shop'

// One place builds the engine client, so relay, worker and ui share the namespace
// rule. Takes only the namespace, not the whole ShopConfig, so a caller that opens
// no database (cancelNamespaceCli.ts) never needs KYU_SHOP_DATABASE_URL to build one.
export function createShopKyu(config: Pick<ShopConfig, 'namespace'>): Kyu {
  const hatchet = createHatchetClient({ namespace: config.namespace })
  return createKyu({ hatchet, source: SHOP_SOURCE })
}

// Publishing stops at the outbox row, so a process that only publishes builds
// no engine client and needs no HATCHET_CLIENT_TOKEN. Namespace is an engine
// concern and has no meaning here.
export function createShopPublisher(): Publisher {
  return createPublisher({ source: SHOP_SOURCE })
}
