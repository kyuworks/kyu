import { parseArgs } from 'node:util'
import { describeError } from '../../log.js'
import type { AssertionFailure } from './assertions.js'
import { cancelLeftoverRuns } from './scenario.js'
import type { LeftoverRunsClient } from './scenario.js'

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
// Only the shape scenarioNamespace (scenario.ts) actually mints: a prefix, then a
// trailing `_<6 hex chars>_`. The old `^[a-z0-9_]+_$` matched any prefix ending in
// one underscore — `shop_`, the live shop's own namespace, included — and the SDK
// cancels by prefix, so that rule could have cancelled the live shop's runs.
const HARNESS_NAMESPACE = /^[a-z0-9_]+_[0-9a-f]{6}_$/

export interface CancelNamespaceOptions {
  namespaces: readonly string[]
  since: Date
}

export interface CancelNamespaceResult {
  namespace: string
  /** Unset when the namespace itself could not be read or cancelled at all. */
  before?: number
  /** Sum of every cancelUnsettledInNamespace call's own return value for this namespace. */
  acceptedByEngine?: number
  left?: number
  failures: readonly AssertionFailure[]
}

interface AcceptedByEngineTracker {
  client: LeftoverRunsClient
  total: () => number
}

// Wraps a client so cancelHarnessNamespaces can total what the engine itself
// accepted, without cancelLeftoverRuns needing to know this CLI reads it.
function trackAcceptedByEngine(client: LeftoverRunsClient): AcceptedByEngineTracker {
  let total = 0
  return {
    client: {
      runs: {
        unsettledInNamespace: (options) => client.runs.unsettledInNamespace(options),
        cancelUnsettledInNamespace: async (options) => {
          const accepted = await client.runs.cancelUnsettledInNamespace(options)
          total += accepted
          return accepted
        },
      },
    },
    total: () => total,
  }
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
    // One namespace's failure to even read or cancel must not lose the
    // outcomes already gathered for namespaces before it.
    try {
      const rawClient = clientFor(namespace)
      const before = (await rawClient.runs.unsettledInNamespace({ since: options.since })).length
      const tracked = trackAcceptedByEngine(rawClient)
      const failures = await cancelLeftoverRuns(tracked.client, namespace, options.since)
      const left = (await rawClient.runs.unsettledInNamespace({ since: options.since })).length
      results.push({ namespace, before, acceptedByEngine: tracked.total(), left, failures })
    } catch (caught) {
      results.push({
        namespace,
        failures: [
          {
            check: 'harness-leaves-nothing',
            detail: `cancelling namespace ${namespace} failed: ${describeError(caught)}`,
          },
        ],
      })
    }
  }
  return results
}
