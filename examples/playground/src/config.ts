export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface PlaygroundConfig {
  databaseUrl: string
  namespace: string
  logLevel: LogLevel
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

// The engine client reads HATCHET_CLIENT_TOKEN and HATCHET_CLIENT_TLS_STRATEGY
// from the environment itself; this function never touches those two.
export function readConfig(env: NodeJS.ProcessEnv = process.env): PlaygroundConfig {
  const databaseUrl = env['KINESIN_EXAMPLE_DATABASE_URL']
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new MissingConfigError('KINESIN_EXAMPLE_DATABASE_URL', 'a postgres connection string')
  }

  const namespace = env['KINESIN_EXAMPLE_NAMESPACE'] ?? 'playground_'

  const logLevelValue = env['KINESIN_EXAMPLE_LOG_LEVEL'] ?? 'info'
  if (!isLogLevel(logLevelValue)) {
    throw new MissingConfigError('KINESIN_EXAMPLE_LOG_LEVEL', `one of ${LOG_LEVELS.join(', ')}`)
  }

  return { databaseUrl, namespace, logLevel: logLevelValue }
}
