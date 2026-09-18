import type { Duration as HatchetDuration } from './hatchet.js'

export {
  MESSAGE_NAME_PATTERN,
  createEnvelope,
  defineCommand,
  defineEvent,
  envelopeSchema,
  messageKindSchema,
  messageNameSchema,
  parseEnvelope,
  uuidv7,
} from '@qtaxis/schemas'
export type {
  CreateEnvelopeOptions,
  Envelope,
  EnvelopeData,
  EnvelopeMetadataFields,
  JsonObject,
  MessageData,
  MessageDataShape,
  MessageDefinition,
  MessageInput,
  MessageKind,
  MessageSchema,
  Unparsed,
} from '@qtaxis/schemas'
export { SDK_VERSION } from './version.js'
export { MIGRATIONS_DIRECTORY } from './migrations.js'

export { createQtaxis } from './createQtaxis.js'
export type { CreateQtaxisOptions, Qtaxis, QtaxisRelayOptions } from './createQtaxis.js'

export type { Queryable, QueryParam, QueryRows } from './db/queryable.js'

export {
  claimPendingRows,
  insertOutboxRow,
  markPublished,
  prunePublished,
  recordPublishFailure,
  releaseClaims,
} from './outbox/outboxRepository.js'
export type { ClaimedRows, ClaimPendingRowsOptions, PrunePublishedOptions } from './outbox/outboxRepository.js'

export { createPublisher, publishEnvelope } from './outbox/publish.js'
export type { CreatePublisherOptions, Publisher, PublisherOptions } from './outbox/publish.js'

export { onceById } from './outbox/onceById.js'
export type { OnceResult } from './outbox/onceById.js'

export { outboxRowSchema, processedRowSchema } from './outbox/rows.js'
export type { OutboxRow, ProcessedRow } from './outbox/rows.js'

export { ConcurrencyLimitStrategy, NonRetryableError, Or, Priority, createHatchetClient } from './hatchet.js'
export type { HatchetClient, HatchetClientConfig, HatchetClientOptions, Worker } from './hatchet.js'
// The string form: `sleepFor`/`waitFor`/`executionTimeout` never take the
// object or millisecond forms the engine's own `Duration` also allows.
export type Duration = Extract<HatchetDuration, string>

export {
  CommandHasTwoSubscribersError,
  EnvelopeOptionsError,
  EnvelopeRejectedError,
  QtaxisError,
  MessageDataError,
  MessageDefinitionError,
} from './errors.js'
export type { EnvelopeOptionIssue, MessageDataIssue } from './errors.js'

export { groupEnvelopesForPush, startRelay } from './relay/index.js'
export type { PushItem, Relay, RelayOptions, TickResult } from './relay/index.js'

export type { ConcurrencyOption } from './consume/concurrency.js'

export type { HandlerContext, HandlerLogger } from './consume/handlerContext.js'

export { subscribe } from './consume/subscribe.js'
export type { SubscribeOptions, Subscription } from './consume/subscribe.js'
export type { RateLimitOption, SharedTaskOptions } from './consume/taskOptions.js'

export { durable } from './consume/durable.js'
export type { DurableHandlerContext, DurableOptions, WaitForOptions, WaitForResult } from './consume/durable.js'

export { createWorker } from './consume/worker.js'
export type { CreateWorkerOptions, QtaxisWorker } from './consume/worker.js'
