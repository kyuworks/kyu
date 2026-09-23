// Cancels what the engine still holds under harness namespaces an earlier run left behind:
//   node examples/shop/dist/__tests__/harness/cancelNamespaceCli.js <namespace>... [--since <iso>]
import nodeProcess from 'node:process'
import { createShopKyu } from '../../kyu.js'
import { log } from '../../log.js'
import { cancelHarnessNamespaces, parseCancelNamespaceOptions } from './cancelNamespace.js'

// No readConfig() here: this command opens no database, and the engine client
// (createHatchetClient, inside createShopKyu) reads HATCHET_CLIENT_TOKEN and
// HATCHET_CLIENT_TLS_STRATEGY from the environment itself. The only setting
// this command needs is the namespace, one per --namespace argument.
const UNKNOWN_COUNT = -1

async function main(): Promise<void> {
  const options = parseCancelNamespaceOptions(nodeProcess.argv.slice(2), new Date())
  const results = await cancelHarnessNamespaces((namespace) => createShopKyu({ namespace }), options)
  for (const { namespace, before, acceptedByEngine, left } of results) {
    log('harness', 'cancel-namespace', {
      namespace,
      found: before ?? UNKNOWN_COUNT,
      acceptedByEngine: acceptedByEngine ?? UNKNOWN_COUNT,
      left: left ?? UNKNOWN_COUNT,
    })
  }
  if (results.some((result) => result.failures.length > 0)) nodeProcess.exitCode = 1
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  log('harness', 'failed', { message })
  nodeProcess.exitCode = 1
})
