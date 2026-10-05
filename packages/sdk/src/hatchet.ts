// The one import site for the engine. The package has no `exports` map, so
// `@hatchet-dev/typescript-sdk/v1` does not resolve under NodeNext; import by file path.
// The root barrel adds the legacy workflow module and the admin client, which this wrapper does not use.
import { V1TaskStatus } from '@hatchet-dev/typescript-sdk/clients/rest/generated/data-contracts.js'
import {
  ConcurrencyLimitStrategy,
  HatchetClient,
  NonRetryableError,
  Or,
  OrCondition,
  Priority,
  RateLimitDuration,
  SleepCondition,
  UserEventCondition,
  durationToMs,
} from '@hatchet-dev/typescript-sdk/v1/index.js'
import type {
  Concurrency,
  Context,
  CreateDurableTaskWorkflowOpts,
  CreateTaskWorkflowOpts,
  CreateWorkerOpts,
  Duration,
  DurableContext,
  JsonObject,
  TaskWorkflowDeclaration,
  Worker,
} from '@hatchet-dev/typescript-sdk/v1/index.js'

export {
  ConcurrencyLimitStrategy,
  NonRetryableError,
  Or,
  OrCondition,
  Priority,
  RateLimitDuration,
  SleepCondition,
  UserEventCondition,
  V1TaskStatus,
  durationToMs,
}
export type {
  Concurrency,
  Context,
  CreateDurableTaskWorkflowOpts,
  CreateTaskWorkflowOpts,
  CreateWorkerOpts,
  Duration,
  DurableContext,
  HatchetClient,
  JsonObject,
  TaskWorkflowDeclaration,
  Worker,
}

/**
 * Base for SDK-raised errors that are not envelope- or message-definition
 * errors from `@kyuworks/schemas`. Defined here, not in `errors.ts`, because
 * `errors.ts` imports `NonRetryableError` from this file; defining it there
 * and importing it back would make the two files circular.
 */
export class KyuError extends Error {
  constructor(message: string, options?: { cause: Error }) {
    super(message, options)
    this.name = 'KyuError'
  }
}

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

/**
 * Maps Kyu's own option names to the engine SDK's `ClientConfig` shape.
 *
 * The engine loader treats `tls_config` as a set: once any TLS option is
 * given, it replaces the whole config (environment defaults included), not
 * just the given keys. So `tls_config` is built only when at least one TLS
 * option is present, and `tls_strategy` is always set on it — from
 * `options.tls`, or a thrown `KyuError` if that was left out.
 */
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
    if (options.tls === undefined) {
      throw new KyuError(
        'tls is required when tlsCertFile, tlsKeyFile, tlsRootCaFile or tlsServerName is set, because the engine ignores its environment defaults once any TLS option is given',
      )
    }
    if (options.tls === 'mtls') {
      const missing: string[] = []
      if (options.tlsCertFile === undefined) {
        missing.push('tlsCertFile')
      }
      if (options.tlsKeyFile === undefined) {
        missing.push('tlsKeyFile')
      }
      if (options.tlsRootCaFile === undefined) {
        missing.push('tlsRootCaFile')
      }
      if (missing.length > 0) {
        throw new KyuError(`tls: 'mtls' requires ${missing.join(', ')}`)
      }
    }
    config.tls_config = { tls_strategy: options.tls }
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

export function createHatchetClient(options: HatchetClientOptions = {}): HatchetClient {
  return HatchetClient.init(toHatchetClientConfig(options))
}
