// The one import site for the engine. The package has no `exports` map, so
// `@hatchet-dev/typescript-sdk/v1` does not resolve under NodeNext; the file
// path below does. The root barrel loads the removed v0 modules and prints
// two `HATCHET_V0_REMOVED` deprecation warnings per process — never import it.
import {
  ConcurrencyLimitStrategy,
  HatchetClient,
  NonRetryableError,
  Or,
  Priority,
} from '@hatchet-dev/typescript-sdk/v1/index.js'
import type { Worker } from '@hatchet-dev/typescript-sdk/v1/index.js'

export { ConcurrencyLimitStrategy, NonRetryableError, Or, Priority }
export type { HatchetClient, Worker }

export interface HatchetClientOptions {
  token?: string
  tls?: 'tls' | 'mtls' | 'none'
  hostPort?: string
  apiUrl?: string
  namespace?: string
  logLevel?: 'OFF' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
}

interface HatchetTlsConfig {
  tls_strategy: 'tls' | 'mtls' | 'none'
}

export interface HatchetClientConfig {
  token?: string
  tls_config?: HatchetTlsConfig
  host_port?: string
  api_url?: string
  namespace?: string
  log_level?: 'OFF' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
}

/** Maps Kinesin's own option names to the engine SDK's `ClientConfig` shape. */
export function toHatchetClientConfig(options: HatchetClientOptions): HatchetClientConfig {
  const config: HatchetClientConfig = {}
  if (options.token !== undefined) {
    config.token = options.token
  }
  if (options.tls !== undefined) {
    config.tls_config = { tls_strategy: options.tls }
  }
  if (options.hostPort !== undefined) {
    config.host_port = options.hostPort
  }
  if (options.apiUrl !== undefined) {
    config.api_url = options.apiUrl
  }
  if (options.namespace !== undefined) {
    config.namespace = options.namespace
  }
  if (options.logLevel !== undefined) {
    config.log_level = options.logLevel
  }
  return config
}

export function createHatchetClient(options: HatchetClientOptions): HatchetClient {
  return HatchetClient.init(toHatchetClientConfig(options))
}
