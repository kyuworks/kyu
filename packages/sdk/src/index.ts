export {
  MESSAGE_NAME_PATTERN,
  envelopeSchema,
  messageKindSchema,
  messageNameSchema,
  parseEnvelope,
} from '@kinesin/schemas'
export type { Envelope, MessageKind } from '@kinesin/schemas'
export { SDK_VERSION } from './version.js'

export { ConcurrencyLimitStrategy, NonRetryableError, Or, Priority, createHatchetClient } from './hatchet.js'
export type { HatchetClient, HatchetClientConfig, HatchetClientOptions, Worker } from './hatchet.js'

export {
  CommandHasTwoSubscribersError,
  EnvelopeOptionsError,
  EnvelopeRejectedError,
  KinesinError,
  MessageDataError,
  MessageDefinitionError,
} from './errors.js'
export type { EnvelopeOptionIssue, MessageDataIssue } from './errors.js'

export { toHatchetConcurrency } from './consume/concurrency.js'
export type { ConcurrencyOption } from './consume/concurrency.js'

export { buildHandlerContext } from './consume/handlerContext.js'
export type { HandlerContext, HandlerLogger } from './consume/handlerContext.js'

export { decodeIncomingEnvelope, subscribe } from './consume/subscribe.js'
export type { RateLimitOption, SubscribeOptions, Subscription } from './consume/subscribe.js'

export { assertSingleCommandSubscriber, createWorker } from './consume/worker.js'
export type { CreateWorkerOptions, KinesinWorker } from './consume/worker.js'
