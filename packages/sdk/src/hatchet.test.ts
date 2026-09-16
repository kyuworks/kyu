import { describe, expect, it } from 'vitest'
import { createHatchetClient, toHatchetClientConfig } from './hatchet.js'

// A syntactically valid but unsigned JWT: header.payload.signature. Good
// enough for HatchetClient.init, which only checks shape, never the network.
const FAKE_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.dGVzdC1zaWduYXR1cmU'

describe('toHatchetClientConfig', () => {
  it('maps tls to tls_config.tls_strategy', () => {
    expect(toHatchetClientConfig({ tls: 'none' })).toEqual({ tls_config: { tls_strategy: 'none' } })
  })

  it('passes namespace through unchanged', () => {
    expect(toHatchetClientConfig({ namespace: 'kt_test' })).toEqual({ namespace: 'kt_test' })
  })

  it('maps hostPort and apiUrl to host_port and api_url', () => {
    expect(toHatchetClientConfig({ hostPort: 'localhost:7077', apiUrl: 'http://localhost:8888' })).toEqual({
      host_port: 'localhost:7077',
      api_url: 'http://localhost:8888',
    })
  })

  it('maps token and logLevel', () => {
    expect(toHatchetClientConfig({ token: FAKE_TOKEN, logLevel: 'DEBUG' })).toEqual({
      token: FAKE_TOKEN,
      log_level: 'DEBUG',
    })
  })

  it('omits fields that were not given', () => {
    expect(toHatchetClientConfig({})).toEqual({})
  })
})

describe('createHatchetClient', () => {
  it('returns a client whose events, task and worker members exist', () => {
    const client = createHatchetClient({
      token: FAKE_TOKEN,
      tls: 'none',
      hostPort: 'localhost:7077',
      apiUrl: 'http://localhost:8888',
      namespace: 'kt_test',
    })

    expect(client.events).toBeDefined()
    expect('task' in client).toBe(true)
    expect('worker' in client).toBe(true)
  })
})
