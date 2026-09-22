import { describe, expect, it } from 'vitest'
import { engineProxyTargetFromEnv } from './proxy.js'

describe('engineProxyTargetFromEnv', () => {
  it('defaults to the local engine when neither variable is set', () => {
    const target = engineProxyTargetFromEnv({})
    expect(target).toMatchObject({ grpcHost: '127.0.0.1', grpcPort: 7077, apiPort: 8888, apiTls: false })
  })

  it('proxies the deployed engine when the client env names it', () => {
    const target = engineProxyTargetFromEnv({
      HATCHET_CLIENT_HOST_PORT: '<engine-app>.fly.dev:7077',
      HATCHET_CLIENT_API_URL: 'https://<engine-app>.fly.dev',
    })
    expect(target).toEqual({
      grpcHost: '<engine-app>.fly.dev',
      grpcPort: 7077,
      apiHost: '<engine-app>.fly.dev',
      apiPort: 443,
      apiTls: true,
      servername: '<engine-app>.fly.dev',
    })
  })

  it('rejects a host:port with no port', () => {
    expect(() => engineProxyTargetFromEnv({ HATCHET_CLIENT_HOST_PORT: '<engine-app>.fly.dev' })).toThrow()
  })
})
