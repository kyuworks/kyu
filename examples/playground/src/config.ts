import type { Duration } from '@kinesin/sdk'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface PlaygroundConfig {
  databaseUrl: string
  namespace: string
  logLevel: LogLevel
  watchShippingTimeout: Duration
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

// The engine client reads HATCHET_CLIENT_TOKEN and HATCHET_CLIENT_TLS_STRATEGY
// from the environment itself; this function never touches those two.
export function readConfig(env: NodeJS.ProcessEnv = process.env): PlaygroundConfig {
  const databaseUrl = env['KINESIN_EXAMPLE_DATABASE_URL']
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new MissingConfigError('KINESIN_EXAMPLE_DATABASE_URL', 'a postgres connection string')
  }

  const namespaceValue = env['KINESIN_EXAMPLE_NAMESPACE']
  if (namespaceValue === '') {
    throw new MissingConfigError('KINESIN_EXAMPLE_NAMESPACE', 'a non-empty prefix')
  }
  const namespace = namespaceValue ?? 'playground_'

  const logLevelValue = env['KINESIN_EXAMPLE_LOG_LEVEL'] ?? 'info'
  if (!isLogLevel(logLevelValue)) {
    throw new MissingConfigError('KINESIN_EXAMPLE_LOG_LEVEL', `one of ${LOG_LEVELS.join(', ')}`)
  }

  const watchShippingTimeout = env['KINESIN_EXAMPLE_WATCH_TIMEOUT'] ?? '3m'
  if (!isDuration(watchShippingTimeout)) {
    throw new MissingConfigError('KINESIN_EXAMPLE_WATCH_TIMEOUT', 'an h/m/s duration string, e.g. "3m" or "30s"')
  }
  if (durationToSeconds(watchShippingTimeout) > MAX_WATCH_SHIPPING_TIMEOUT_SECONDS) {
    throw new MissingConfigError(
      'KINESIN_EXAMPLE_WATCH_TIMEOUT',
      'an h/m/s duration string of 20 minutes or less (the watch-shipping execution timeout is fixed at 1h)',
    )
  }

  return { databaseUrl, namespace, logLevel: logLevelValue, watchShippingTimeout }
}
