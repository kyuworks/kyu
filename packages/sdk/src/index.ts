export {
  MESSAGE_NAME_PATTERN,
  envelopeSchema,
  messageKindSchema,
  messageNameSchema,
  parseEnvelope,
} from '@kinesin/schemas'
export type { Envelope, MessageKind } from '@kinesin/schemas'
export { SDK_VERSION } from './version.js'

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
