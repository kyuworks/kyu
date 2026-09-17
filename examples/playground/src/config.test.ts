import { describe, expect, it } from 'vitest'
import { MissingConfigError, readConfig } from './config.js'

describe('readConfig', () => {
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
