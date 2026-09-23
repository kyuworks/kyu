// Cancels what the engine still holds under harness namespaces an earlier run left behind:
//   node examples/shop/dist/__tests__/harness/cancelNamespaceCli.js <namespace>... [--since <iso>]
import nodeProcess from 'node:process'
import { readConfig } from '../../config.js'
import { createShopKyu } from '../../kyu.js'
import { log } from '../../log.js'
import { cancelHarnessNamespaces, parseCancelNamespaceOptions } from './cancelNamespace.js'

async function main(): Promise<void> {
  const options = parseCancelNamespaceOptions(nodeProcess.argv.slice(2), new Date())
  const config = readConfig()
  const results = await cancelHarnessNamespaces((namespace) => createShopKyu({ ...config, namespace }), options)
  for (const { namespace, before, failures } of results) {
    log('harness', 'cancel-namespace', {
      namespace,
      before,
      left: failures.map((f) => f.detail).join('; '),
    })
  }
  if (results.some((result) => result.failures.length > 0)) nodeProcess.exitCode = 1
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  log('harness', 'failed', { message })
  nodeProcess.exitCode = 1
})
