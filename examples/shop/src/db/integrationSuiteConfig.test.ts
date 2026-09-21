import { describe, expect, it } from 'vitest'
import integrationConfig from '../../vitest.integration.config.js'

// A per-file clean is the only clean start an integration file cannot forget:
// vitest orders files by size, so a leaking file lands on a different
// neighbour in CI than it does locally.
describe('shop integration suite config', () => {
  it('empties the bus and shop tables before every integration file', () => {
    expect(integrationConfig.test?.setupFiles).toContain('./vitest.integration.clearTables.ts')
  })
})
