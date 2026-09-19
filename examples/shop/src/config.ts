import type { Duration } from '@kyuworks/sdk'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ShopConfig {
  databaseUrl: string
  namespace: string
  logLevel: LogLevel
  watchShippingTimeout: Duration
  // Unset lets the relay fall back to the SDK's own default batch size.
  relayBatchSize?: number
  uiPort: number
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

function isLogLevel(value: string): value is LogLevel {
  return LOG_LEVELS.some((level) => level === value)
}

// The engine's own Duration string grammar (h then m then s, each optional):
// packages/sdk wraps it but does not export the parser, so tests can shorten it.
const DURATION_PATTERN = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/

function isDuration(value: string): value is Duration {
  return value !== '' && DURATION_PATTERN.test(value)
}

// watch-shipping's executionTimeout is fixed at 1h (handlers/watchShipping.ts); a
// configured wait above that would let the engine cancel the run mid-wait.
const MAX_WATCH_SHIPPING_TIMEOUT_SECONDS = 20 * 60

function durationToSeconds(value: Duration): number {
  const match = DURATION_PATTERN.exec(value)
  const hours = match?.[1]
  const minutes = match?.[2]
  const seconds = match?.[3]
  return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)
}

/** A required environment variable was missing, or an optional one held a value outside its contract. */
export class MissingConfigError extends Error {
  readonly variable: string

  constructor(variable: string, expected: string) {
    super(`environment variable ${variable} is missing or invalid: expected ${expected}`)
    this.name = 'MissingConfigError'
    this.variable = variable
  }
}

function parseRelayBatchSize(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new MissingConfigError('KYU_SHOP_RELAY_BATCH_SIZE', 'a positive integer')
  }
  return parsed
}

const DEFAULT_UI_PORT = 3333

function parseUiPort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_UI_PORT
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new MissingConfigError('KYU_SHOP_UI_PORT', 'an integer between 1 and 65535')
  }
  return parsed
}

// The engine client reads HATCHET_CLIENT_TOKEN and HATCHET_CLIENT_TLS_STRATEGY
// from the environment itself; this function never touches those two.
export function readConfig(env: NodeJS.ProcessEnv = process.env): ShopConfig {
  const databaseUrl = env['KYU_SHOP_DATABASE_URL']
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new MissingConfigError('KYU_SHOP_DATABASE_URL', 'a postgres connection string')
  }

  const namespaceValue = env['KYU_SHOP_NAMESPACE']
  if (namespaceValue === '') {
    throw new MissingConfigError('KYU_SHOP_NAMESPACE', 'a non-empty prefix')
  }
  const namespace = namespaceValue ?? 'shop_'

  const logLevelValue = env['KYU_SHOP_LOG_LEVEL'] ?? 'info'
  if (!isLogLevel(logLevelValue)) {
    throw new MissingConfigError('KYU_SHOP_LOG_LEVEL', `one of ${LOG_LEVELS.join(', ')}`)
  }

  const watchShippingTimeout = env['KYU_SHOP_WATCH_TIMEOUT'] ?? '3m'
  if (!isDuration(watchShippingTimeout)) {
    throw new MissingConfigError('KYU_SHOP_WATCH_TIMEOUT', 'an h/m/s duration string, e.g. "3m" or "30s"')
  }
  if (durationToSeconds(watchShippingTimeout) > MAX_WATCH_SHIPPING_TIMEOUT_SECONDS) {
    throw new MissingConfigError(
      'KYU_SHOP_WATCH_TIMEOUT',
      'an h/m/s duration string of 20 minutes or less (the watch-shipping execution timeout is fixed at 1h)',
    )
  }

  const relayBatchSize = parseRelayBatchSize(env['KYU_SHOP_RELAY_BATCH_SIZE'])
  const uiPort = parseUiPort(env['KYU_SHOP_UI_PORT'])

  const config: ShopConfig = {
    databaseUrl,
    namespace,
    logLevel: logLevelValue,
    watchShippingTimeout,
    uiPort,
  }
  if (relayBatchSize !== undefined) config.relayBatchSize = relayBatchSize
  return config
}
