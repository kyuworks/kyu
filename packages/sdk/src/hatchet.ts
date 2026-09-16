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
  tlsCertFile?: string
  tlsKeyFile?: string
  tlsRootCaFile?: string
  tlsServerName?: string
  hostPort?: string
  apiUrl?: string
  namespace?: string
  logLevel?: 'OFF' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
}

/**
 * The engine's own config shape, read off `HatchetClient.init` itself so a
 * misspelt field here is a compile error rather than a silently dropped option.
 */
export type HatchetClientConfig = NonNullable<Parameters<typeof HatchetClient.init>[0]>

/** Maps Kinesin's own option names to the engine SDK's `ClientConfig` shape. */
export function toHatchetClientConfig(options: HatchetClientOptions): HatchetClientConfig {
  const config: HatchetClientConfig = {}
  if (options.token !== undefined) {
    config.token = options.token
  }
  const hasTlsOption =
    options.tls !== undefined ||
    options.tlsCertFile !== undefined ||
    options.tlsKeyFile !== undefined ||
    options.tlsRootCaFile !== undefined ||
    options.tlsServerName !== undefined
  if (hasTlsOption) {
    config.tls_config = {}
    if (options.tls !== undefined) {
      config.tls_config.tls_strategy = options.tls
    }
    if (options.tlsCertFile !== undefined) {
      config.tls_config.cert_file = options.tlsCertFile
    }
    if (options.tlsKeyFile !== undefined) {
      config.tls_config.key_file = options.tlsKeyFile
    }
    if (options.tlsRootCaFile !== undefined) {
      config.tls_config.ca_file = options.tlsRootCaFile
    }
    if (options.tlsServerName !== undefined) {
      config.tls_config.server_name = options.tlsServerName
    }
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
