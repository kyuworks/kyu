import { describe, expect, it } from 'vitest'
import { ClientConfigSchema } from '@hatchet-dev/typescript-sdk/clients/hatchet-client/client-config.js'
import { createHatchetClient, toHatchetClientConfig } from './hatchet.js'

// A syntactically valid but unsigned JWT: header.payload.signature. Good
// enough for HatchetClient.init, which only checks shape, never the network.
const FAKE_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.dGVzdC1zaWduYXR1cmU'

// Runs every mapped config through the engine's own (partial) schema, so a
// field the engine would reject fails here rather than only at connect time.
function parseAgainstEngine(config: ReturnType<typeof toHatchetClientConfig>) {
  return ClientConfigSchema.partial().parse(config)
}

describe('toHatchetClientConfig', () => {
  it('maps tls to tls_config.tls_strategy', () => {
    const config = toHatchetClientConfig({ tls: 'none' })
    expect(parseAgainstEngine(config)).toMatchObject({ tls_config: { tls_strategy: 'none' } })
  })

  it('maps the TLS file options onto tls_config', () => {
    const config = toHatchetClientConfig({
      tlsCertFile: 'cert.pem',
      tlsKeyFile: 'key.pem',
      tlsRootCaFile: 'ca.pem',
      tlsServerName: 'engine.internal',
    })
    expect(parseAgainstEngine(config)).toMatchObject({
      tls_config: {
        cert_file: 'cert.pem',
        key_file: 'key.pem',
        ca_file: 'ca.pem',
        server_name: 'engine.internal',
      },
    })
  })

  it('passes namespace through unchanged', () => {
    const config = toHatchetClientConfig({ namespace: 'kt_test' })
    expect(parseAgainstEngine(config)).toMatchObject({ namespace: 'kt_test' })
  })

  it('maps hostPort and apiUrl to host_port and api_url', () => {
    const config = toHatchetClientConfig({ hostPort: 'localhost:7077', apiUrl: 'http://localhost:8888' })
    expect(parseAgainstEngine(config)).toMatchObject({
      host_port: 'localhost:7077',
      api_url: 'http://localhost:8888',
    })
  })

  it('maps token and logLevel', () => {
    const config = toHatchetClientConfig({ token: FAKE_TOKEN, logLevel: 'DEBUG' })
    expect(parseAgainstEngine(config)).toMatchObject({
      token: FAKE_TOKEN,
      log_level: 'DEBUG',
    })
  })

  it('omits fields that were not given', () => {
    expect(toHatchetClientConfig({})).toEqual({})
  })
})

describe('createHatchetClient', () => {
  it('builds a client whose engine config matches the given options', () => {
    const client = createHatchetClient({
      token: FAKE_TOKEN,
      hostPort: 'localhost:7077',
      apiUrl: 'http://localhost:8888',
      namespace: 'kt_test',
      tls: 'none',
    })

    // The engine appends a trailing "_" to any namespace that lacks one.
    expect(client.config.namespace).toBe('kt_test_')
    expect(client.config.host_port).toBe('localhost:7077')
    expect(client.config.api_url).toBe('http://localhost:8888')
    expect(client.config.tls_config.tls_strategy).toBe('none')
  })
})
