import { parseArgs } from 'node:util'
import type { AssertionFailure } from './assertions.js'
import { cancelLeftoverRuns } from './scenario.js'
import type { LeftoverRunsClient } from './scenario.js'

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const HARNESS_NAMESPACE = /^[a-z0-9_]+_$/

export interface CancelNamespaceOptions {
  namespaces: readonly string[]
  since: Date
}

export interface CancelNamespaceResult {
  namespace: string
  before: number
  failures: readonly AssertionFailure[]
}

/** The command line named no namespace, a malformed one, or an invalid --since. */
export class CancelNamespaceOptionsError extends Error {}

/** This CLI's own trust edge: argv → options, or throws. */
export function parseCancelNamespaceOptions(argv: readonly string[], now: Date): CancelNamespaceOptions {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { since: { type: 'string' } },
    allowPositionals: true,
  })
  if (positionals.length === 0) {
    throw new CancelNamespaceOptionsError('at least one namespace is required')
  }
  for (const namespace of positionals) {
    if (!HARNESS_NAMESPACE.test(namespace)) {
      throw new CancelNamespaceOptionsError(
        `"${namespace}" is not a harness namespace: expected lowercase letters, digits and underscores, ending in "_"`,
      )
    }
  }
  const since = values.since === undefined ? new Date(now.getTime() - DEFAULT_LOOKBACK_MS) : new Date(values.since)
  if (Number.isNaN(since.getTime())) {
    throw new CancelNamespaceOptionsError(`--since is not a valid date: "${String(values.since)}"`)
  }
  return { namespaces: positionals, since }
}

// One namespace at a time: each cancelLeftoverRuns call already retries and
// waits on its own namespace, and the engine is shared with other lanes, so
// nothing here needs to run namespaces concurrently.
export async function cancelHarnessNamespaces(
  clientFor: (namespace: string) => LeftoverRunsClient,
  options: CancelNamespaceOptions,
): Promise<readonly CancelNamespaceResult[]> {
  const results: CancelNamespaceResult[] = []
  for (const namespace of options.namespaces) {
    const client = clientFor(namespace)
    const before = (await client.runs.unsettledInNamespace({ since: options.since })).length
    const failures = await cancelLeftoverRuns(client, namespace, options.since)
    results.push({ namespace, before, failures })
  }
  return results
}
