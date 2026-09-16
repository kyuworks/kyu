import type { Envelope, MessageDataShape } from '@kinesin/schemas'
import type { Context, JsonObject } from '../hatchet.js'

export interface HandlerLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  debug(message: string): void
}

export interface HandlerContext<TData extends MessageDataShape> {
  envelope: Envelope<TData>
  metadata: Record<string, string>
  retryCount: number
  runId: string
  logger: HandlerLogger
}

// Wraps ctx.logger in arrow functions rather than passing its methods
// unbound; Hatchet's logger methods return a promise the handler does not
// need to await.
export function buildHandlerContext<TData extends MessageDataShape>(
  envelope: Envelope<TData>,
  hatchetContext: Context<JsonObject>,
): HandlerContext<TData> {
  return {
    envelope,
    metadata: hatchetContext.additionalMetadata(),
    retryCount: hatchetContext.retryCount(),
    runId: hatchetContext.workflowRunId(),
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
