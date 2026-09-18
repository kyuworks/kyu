import type { Kinesin } from '@kinesin/sdk'
import { createHatchetClient, createKinesin } from '@kinesin/sdk'
import type { PlaygroundConfig } from './config.js'

// Every producer publishes under this source; ui/busTopology.ts reads it too,
// so the diagram's producer box can never name a source nothing uses.
export const PLAYGROUND_SOURCE = 'playground'

// One place builds the client, so migrate, relay, worker and the CLI all share the namespace rule.
export function createPlaygroundKinesin(config: PlaygroundConfig): Kinesin {
  const hatchet = createHatchetClient({ namespace: config.namespace })
  return createKinesin({ hatchet, source: PLAYGROUND_SOURCE })
}
