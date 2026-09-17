import type { Kinesin } from '@kinesin/sdk'
import { createHatchetClient, createKinesin } from '@kinesin/sdk'
import type { PlaygroundConfig } from './config.js'

// One place builds the client, so migrate, relay, worker and the CLI all share the namespace rule.
export function createPlaygroundKinesin(config: PlaygroundConfig): Kinesin {
  const hatchet = createHatchetClient({ namespace: config.namespace })
  return createKinesin({ hatchet, source: 'playground' })
}
