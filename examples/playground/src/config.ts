export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface PlaygroundConfig {
  databaseUrl: string
  namespace: string
  logLevel: LogLevel
  // Unset lets the relay fall back to the SDK's own default batch size.
  relayBatchSize?: number
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

function isLogLevel(value: string): value is LogLevel {
  return LOG_LEVELS.some((level) => level === value)
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
    throw new MissingConfigError('KINESIN_EXAMPLE_RELAY_BATCH_SIZE', 'a positive integer')
  }
  return parsed
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

  const relayBatchSize = parseRelayBatchSize(env['KINESIN_EXAMPLE_RELAY_BATCH_SIZE'])

  const config: PlaygroundConfig = { databaseUrl, namespace, logLevel: logLevelValue }
  if (relayBatchSize !== undefined) config.relayBatchSize = relayBatchSize
  return config
}
