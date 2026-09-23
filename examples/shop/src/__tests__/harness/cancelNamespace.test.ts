import { describe, expect, it, vi } from 'vitest'
import type { RunOutcome } from '@kyuworks/sdk'
import { CancelNamespaceOptionsError, cancelHarnessNamespaces, parseCancelNamespaceOptions } from './cancelNamespace.js'
import type { LeftoverRunsClient } from './scenario.js'

function fakeRun(attempts = 1): RunOutcome {
  return { subscription: 'watch-shipping', status: 'running', attempts, runId: 'run-1', createdAt: new Date() }
}

describe('parseCancelNamespaceOptions', () => {
  it('reads every namespace and defaults since to seven days before now', () => {
    const now = new Date('2026-09-30T00:00:00Z')
    const options = parseCancelNamespaceOptions(['inregion166_tenant_load_593c3d_', 'fly162_tenant_load_2072de_'], now)

    expect(options.namespaces).toEqual(['inregion166_tenant_load_593c3d_', 'fly162_tenant_load_2072de_'])
    expect(options.since.toISOString()).toBe('2026-09-23T00:00:00.000Z')
  })

  it('reads --since as an ISO date', () => {
    const options = parseCancelNamespaceOptions(['a_b_1a2b3c_', '--since', '2026-09-22T00:00:00Z'], new Date())

    expect(options.since.toISOString()).toBe('2026-09-22T00:00:00.000Z')
  })

  it('rejects no namespace, a namespace without a trailing underscore, an uppercase namespace, and an invalid --since', () => {
    const now = new Date()
    expect(() => parseCancelNamespaceOptions([], now)).toThrow(CancelNamespaceOptionsError)
    expect(() => parseCancelNamespaceOptions(['inregion166'], now)).toThrow(CancelNamespaceOptionsError)
    expect(() => parseCancelNamespaceOptions(['Shop_'], now)).toThrow(CancelNamespaceOptionsError)
    expect(() => parseCancelNamespaceOptions(['a_', '--since', 'soon'], now)).toThrow(CancelNamespaceOptionsError)
  })

  // The old rule (`^[a-z0-9_]+_$`) matched any prefix ending in one underscore, so
  // `shop_` — the live shop's own namespace — would have been accepted and the SDK
  // cancels by prefix. Only the scenario shape runScenario actually mints
  // (`scenarioNamespace`, scenario.ts) is accepted now.
  it('rejects a bare project prefix like shop_, which the old rule accepted, and a lone underscore', () => {
    const now = new Date()
    expect(() => parseCancelNamespaceOptions(['shop_'], now)).toThrow(CancelNamespaceOptionsError)
    expect(() => parseCancelNamespaceOptions(['_'], now)).toThrow(CancelNamespaceOptionsError)
  })
})

describe('cancelHarnessNamespaces', () => {
  it('reports the count found before cancelling and cancels each namespace with its own client', async () => {
    vi.useFakeTimers()
    const requestedNamespaces: string[] = []
    const clientFor = (namespace: string): LeftoverRunsClient => {
      requestedNamespaces.push(namespace)
      let reads = 0
      return {
        runs: {
          cancelUnsettledInNamespace: async () => 0,
          unsettledInNamespace: async () => {
            reads += 1
            return reads === 1 ? [fakeRun(2)] : []
          },
        },
      }
    }

    const resultPromise = cancelHarnessNamespaces(clientFor, {
      namespaces: ['a_', 'b_'],
      since: new Date('2026-01-01T00:00:00.000Z'),
    })
    await vi.advanceTimersByTimeAsync(240_000)

    expect(await resultPromise).toEqual([
      { namespace: 'a_', before: 1, acceptedByEngine: 0, left: 0, failures: [] },
      { namespace: 'b_', before: 1, acceptedByEngine: 0, left: 0, failures: [] },
    ])
    expect(requestedNamespaces).toEqual(['a_', 'b_'])
  })
})
