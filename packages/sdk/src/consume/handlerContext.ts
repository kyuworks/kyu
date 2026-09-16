import type { Envelope, EnvelopeMetadataFields, MessageDataShape } from '@kinesin/schemas'
import type { Context, JsonObject } from '../hatchet.js'

export interface HandlerLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  debug(message: string): void
}

export interface HandlerContext<TData extends MessageDataShape> {
  envelope: Envelope<TData>
  /** Decoded from the engine's `additionalMetadata`; `runHandler` has already checked its `envelopeId` and `tenantId` agree with `envelope`. */
  metadata: EnvelopeMetadataFields
  retryCount: number
  runId: string
  /** Aborts when the engine cancels this run (coalescing, timeout, manual cancel). */
  signal: AbortSignal
  logger: HandlerLogger
}

// Arrow wrappers, not unbound methods; the engine's logger returns a promise the handler need not await.
export function buildHandlerContext<TData extends MessageDataShape>(
  envelope: Envelope<TData>,
  metadata: EnvelopeMetadataFields,
  hatchetContext: Context<JsonObject>,
): HandlerContext<TData> {
  return {
    envelope,
    metadata,
    retryCount: hatchetContext.retryCount(),
    runId: hatchetContext.workflowRunId(),
    signal: hatchetContext.abortController.signal,
    logger: {
      info: (message) => {
        void hatchetContext.logger.info(message)
      },
      warn: (message) => {
        void hatchetContext.logger.warn(message)
      },
      error: (message) => {
        void hatchetContext.logger.error(message)
      },
      debug: (message) => {
        void hatchetContext.logger.debug(message)
      },
    },
  }
}
