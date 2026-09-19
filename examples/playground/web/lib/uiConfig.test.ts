import { describe, expect, it } from 'vitest'
import { parseUiConfig } from './uiConfig'

describe('parseUiConfig', () => {
  it('parses a valid /ui.json body', () => {
    const outcome = parseUiConfig(JSON.stringify({ dashboardUrl: 'http://localhost:8888' }))

    expect(outcome).toEqual({ ok: true, config: { dashboardUrl: 'http://localhost:8888' } })
  })

  it('refuses a body that is not valid JSON', () => {
    const outcome = parseUiConfig('{not json')

    expect(outcome).toEqual({ ok: false, error: 'invalid JSON body' })
  })

  it('refuses a body missing dashboardUrl', () => {
    const outcome = parseUiConfig(JSON.stringify({}))

    expect(outcome.ok).toBe(false)
  })
})
