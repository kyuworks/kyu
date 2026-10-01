import { describe, expect, it } from 'vitest'
import { engineProxyTargetFromEnv } from './proxy.js'

describe('engineProxyTargetFromEnv', () => {
  it('defaults to the local engine when neither variable is set', () => {
    const target = engineProxyTargetFromEnv({})
    expect(target).toMatchObject({ grpcHost: '127.0.0.1', grpcPort: 7077, apiPort: 8888, apiTls: false })
  })

  it('proxies the deployed engine when the client env names it', () => {
    const target = engineProxyTargetFromEnv({
      HATCHET_CLIENT_HOST_PORT: 'engine.example.com:7077',
      HATCHET_CLIENT_API_URL: 'https://engine.example.com',
    })
    expect(target).toEqual({
      grpcHost: 'engine.example.com',
      grpcPort: 7077,
      apiHost: 'engine.example.com',
      apiPort: 443,
      apiTls: true,
      servername: 'engine.example.com',
    })
  })

  it('rejects a host:port with no port', () => {
    expect(() => engineProxyTargetFromEnv({ HATCHET_CLIENT_HOST_PORT: 'engine.example.com' })).toThrow()
  })

  it('rejects a bare (unbracketed) IPv6 literal as ambiguous', () => {
    expect(() => engineProxyTargetFromEnv({ HATCHET_CLIENT_HOST_PORT: '::1:7077' })).toThrow()
  })

  it('accepts a bracketed IPv6 literal', () => {
    const target = engineProxyTargetFromEnv({ HATCHET_CLIENT_HOST_PORT: '[::1]:7077' })
    expect(target).toMatchObject({ grpcHost: '[::1]', grpcPort: 7077 })
  })
})
