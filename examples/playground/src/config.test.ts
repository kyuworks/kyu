import { afterEach, describe, expect, it, vi } from 'vitest'
import { MissingConfigError, readConfig } from './config.js'

describe('readConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('throws MissingConfigError naming the missing database url', () => {
    let error: MissingConfigError | undefined
    try {
      readConfig({})
    } catch (caught) {
      if (caught instanceof MissingConfigError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(MissingConfigError)
    expect(error?.variable).toBe('KINESIN_EXAMPLE_DATABASE_URL')
    expect(error?.message).toContain('KINESIN_EXAMPLE_DATABASE_URL')
  })

  it('throws MissingConfigError naming the variable for an empty database url', () => {
    let error: MissingConfigError | undefined
    try {
      readConfig({ KINESIN_EXAMPLE_DATABASE_URL: '' })
    } catch (caught) {
      if (caught instanceof MissingConfigError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(MissingConfigError)
    expect(error?.variable).toBe('KINESIN_EXAMPLE_DATABASE_URL')
  })

  it('throws MissingConfigError naming the variable for an empty namespace', () => {
    let error: MissingConfigError | undefined
    try {
      readConfig({
        KINESIN_EXAMPLE_DATABASE_URL: 'postgresql://localhost/db',
        KINESIN_EXAMPLE_NAMESPACE: '',
      })
    } catch (caught) {
      if (caught instanceof MissingConfigError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(MissingConfigError)
    expect(error?.variable).toBe('KINESIN_EXAMPLE_NAMESPACE')
  })

  it('reads from process.env by default', () => {
    vi.stubEnv('KINESIN_EXAMPLE_DATABASE_URL', 'postgresql://localhost/from-env')
    vi.stubEnv('KINESIN_EXAMPLE_NAMESPACE', 'env_')
    vi.stubEnv('KINESIN_EXAMPLE_LOG_LEVEL', 'warn')

    const config = readConfig()

    expect(config.databaseUrl).toBe('postgresql://localhost/from-env')
    expect(config.namespace).toBe('env_')
    expect(config.logLevel).toBe('warn')
  })

  it('defaults namespace and log level when unset', () => {
    const config = readConfig({ KINESIN_EXAMPLE_DATABASE_URL: 'postgresql://localhost/db' })
    expect(config.databaseUrl).toBe('postgresql://localhost/db')
    expect(config.namespace).toBe('playground_')
    expect(config.logLevel).toBe('info')
  })

  it('reads namespace and log level when set', () => {
    const config = readConfig({
      KINESIN_EXAMPLE_DATABASE_URL: 'postgresql://localhost/db',
      KINESIN_EXAMPLE_NAMESPACE: 'other_',
      KINESIN_EXAMPLE_LOG_LEVEL: 'debug',
    })
    expect(config.namespace).toBe('other_')
    expect(config.logLevel).toBe('debug')
  })

  it('throws MissingConfigError naming the variable and the allowed values for an invalid log level', () => {
    let error: MissingConfigError | undefined
    try {
      readConfig({
        KINESIN_EXAMPLE_DATABASE_URL: 'postgresql://localhost/db',
        KINESIN_EXAMPLE_LOG_LEVEL: 'verbose',
      })
    } catch (caught) {
      if (caught instanceof MissingConfigError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(MissingConfigError)
    expect(error?.variable).toBe('KINESIN_EXAMPLE_LOG_LEVEL')
    expect(error?.message).toContain('debug')
    expect(error?.message).toContain('error')
  })
})
