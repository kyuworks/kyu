import { describe, expect, it } from 'vitest'
import { parseEnvelope, SDK_VERSION } from './index.js'

describe('sdk entry point', () => {
  it('exports a semver version', () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('re-exports the envelope parser from @kyuworks/schemas', () => {
    const parsed = parseEnvelope({
      id: '01923e4a-7b1c-7f3e-8a2d-3c4b5a6d7e8f',
      name: 'kyu.sdk.smoke_tested',
      version: 1,
      kind: 'event',
      occurredAt: '2026-09-16T10:00:00.000Z',
      tenantId: null,
      correlationId: '01923e4a-7b1c-7f3e-8a2d-3c4b5a6d7e90',
      source: 'kyu.sdk.test',
      data: {},
    })
    expect(parsed.name).toBe('kyu.sdk.smoke_tested')
  })
})
