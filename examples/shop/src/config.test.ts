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
    expect(error?.variable).toBe('KYU_SHOP_DATABASE_URL')
    expect(error?.message).toContain('KYU_SHOP_DATABASE_URL')
  })

  it('throws MissingConfigError naming the variable for an empty database url', () => {
    let error: MissingConfigError | undefined
    try {
      readConfig({ KYU_SHOP_DATABASE_URL: '' })
    } catch (caught) {
      if (caught instanceof MissingConfigError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(MissingConfigError)
    expect(error?.variable).toBe('KYU_SHOP_DATABASE_URL')
  })

  it('throws MissingConfigError naming the variable for an empty namespace', () => {
    let error: MissingConfigError | undefined
    try {
      readConfig({
        KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db',
        KYU_SHOP_NAMESPACE: '',
      })
    } catch (caught) {
      if (caught instanceof MissingConfigError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(MissingConfigError)
    expect(error?.variable).toBe('KYU_SHOP_NAMESPACE')
  })

  it('reads from process.env by default', () => {
    vi.stubEnv('KYU_SHOP_DATABASE_URL', 'postgresql://localhost/from-env')
    vi.stubEnv('KYU_SHOP_NAMESPACE', 'env_')
    vi.stubEnv('KYU_SHOP_LOG_LEVEL', 'warn')

    const config = readConfig()

    expect(config.databaseUrl).toBe('postgresql://localhost/from-env')
    expect(config.namespace).toBe('env_')
    expect(config.logLevel).toBe('warn')
  })

  it('defaults namespace, log level and the watch-shipping timeout when unset', () => {
    const config = readConfig({ KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db' })
    expect(config.databaseUrl).toBe('postgresql://localhost/db')
    expect(config.namespace).toBe('shop_')
    expect(config.logLevel).toBe('info')
    expect(config.watchShippingTimeout).toBe('3m')
  })

  it('reads namespace, log level and the watch-shipping timeout when set', () => {
    const config = readConfig({
      KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db',
      KYU_SHOP_NAMESPACE: 'other_',
      KYU_SHOP_LOG_LEVEL: 'debug',
      KYU_SHOP_WATCH_TIMEOUT: '20s',
    })
    expect(config.namespace).toBe('other_')
    expect(config.logLevel).toBe('debug')
    expect(config.watchShippingTimeout).toBe('20s')
  })

  it('throws MissingConfigError naming the variable for an invalid watch-shipping timeout', () => {
    let error: MissingConfigError | undefined
    try {
      readConfig({
        KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db',
        KYU_SHOP_WATCH_TIMEOUT: '5 minutes',
      })
    } catch (caught) {
      if (caught instanceof MissingConfigError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(MissingConfigError)
    expect(error?.variable).toBe('KYU_SHOP_WATCH_TIMEOUT')
  })

  it('accepts a watch-shipping timeout of exactly 20 minutes', () => {
    const config = readConfig({
      KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db',
      KYU_SHOP_WATCH_TIMEOUT: '20m',
    })
    expect(config.watchShippingTimeout).toBe('20m')
  })

  it('throws MissingConfigError naming the variable for a watch-shipping timeout over 20 minutes', () => {
    let error: MissingConfigError | undefined
    try {
      readConfig({
        KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db',
        KYU_SHOP_WATCH_TIMEOUT: '21m',
      })
    } catch (caught) {
      if (caught instanceof MissingConfigError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(MissingConfigError)
    expect(error?.variable).toBe('KYU_SHOP_WATCH_TIMEOUT')
  })

  it('leaves relayBatchSize unset when KYU_SHOP_RELAY_BATCH_SIZE is unset', () => {
    const config = readConfig({ KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db' })
    expect(config.relayBatchSize).toBeUndefined()
  })

  it('reads relayBatchSize when KYU_SHOP_RELAY_BATCH_SIZE is a positive integer', () => {
    const config = readConfig({
      KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db',
      KYU_SHOP_RELAY_BATCH_SIZE: '5',
    })
    expect(config.relayBatchSize).toBe(5)
  })

  it('throws MissingConfigError naming the variable for a non-integer relay batch size', () => {
    let error: MissingConfigError | undefined
    try {
      readConfig({
        KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db',
        KYU_SHOP_RELAY_BATCH_SIZE: 'nope',
      })
    } catch (caught) {
      if (caught instanceof MissingConfigError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(MissingConfigError)
    expect(error?.variable).toBe('KYU_SHOP_RELAY_BATCH_SIZE')
  })

  it('throws MissingConfigError naming the variable for a zero or negative relay batch size', () => {
    expect(() =>
      readConfig({
        KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db',
        KYU_SHOP_RELAY_BATCH_SIZE: '0',
      }),
    ).toThrow('KYU_SHOP_RELAY_BATCH_SIZE')
  })

  it('defaults uiPort to 3333 when unset', () => {
    const config = readConfig({ KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db' })
    expect(config.uiPort).toBe(3333)
  })

  it('reads uiPort when set to a valid port', () => {
    const config = readConfig({
      KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db',
      KYU_SHOP_UI_PORT: '4000',
    })
    expect(config.uiPort).toBe(4000)
  })

  it('throws MissingConfigError naming the variable for an invalid uiPort', () => {
    let error: MissingConfigError | undefined
    try {
      readConfig({
        KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db',
        KYU_SHOP_UI_PORT: '70000',
      })
    } catch (caught) {
      if (caught instanceof MissingConfigError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(MissingConfigError)
    expect(error?.variable).toBe('KYU_SHOP_UI_PORT')
  })

  it('throws MissingConfigError naming the variable and the allowed values for an invalid log level', () => {
    let error: MissingConfigError | undefined
    try {
      readConfig({
        KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db',
        KYU_SHOP_LOG_LEVEL: 'verbose',
      })
    } catch (caught) {
      if (caught instanceof MissingConfigError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(MissingConfigError)
    expect(error?.variable).toBe('KYU_SHOP_LOG_LEVEL')
    expect(error?.message).toContain('debug')
    expect(error?.message).toContain('error')
  })

  it('defaults workerSlots and workerDurableSlots to 5 when unset', () => {
    const config = readConfig({ KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db' })
    expect(config.workerSlots).toBe(5)
    expect(config.workerDurableSlots).toBe(5)
  })

  it('reads workerSlots and workerDurableSlots when set', () => {
    const config = readConfig({
      KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db',
      KYU_SHOP_SLOTS: '50',
      KYU_SHOP_DURABLE_SLOTS: '200',
    })
    expect(config.workerSlots).toBe(50)
    expect(config.workerDurableSlots).toBe(200)
  })

  it('throws MissingConfigError naming the variable for a zero worker slot count', () => {
    let error: MissingConfigError | undefined
    try {
      readConfig({
        KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db',
        KYU_SHOP_SLOTS: '0',
      })
    } catch (caught) {
      if (caught instanceof MissingConfigError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(MissingConfigError)
    expect(error?.variable).toBe('KYU_SHOP_SLOTS')
  })

  it('throws MissingConfigError naming the variable for a non-integer durable slot count', () => {
    let error: MissingConfigError | undefined
    try {
      readConfig({
        KYU_SHOP_DATABASE_URL: 'postgresql://localhost/db',
        KYU_SHOP_DURABLE_SLOTS: 'abc',
      })
    } catch (caught) {
      if (caught instanceof MissingConfigError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(MissingConfigError)
    expect(error?.variable).toBe('KYU_SHOP_DURABLE_SLOTS')
  })
})
