import { NonRetryableError, KyuError } from './hatchet.js'

export {
  EnvelopeMetadataError,
  EnvelopeOptionsError,
  MessageDataError,
  MessageDefinitionError,
} from '@kyuworks/schemas'
export type { EnvelopeOptionIssue, MessageDataIssue } from '@kyuworks/schemas'
export { KyuError } from './hatchet.js'

/** `createWorker` refuses two subscriptions to the same command name. */
export class CommandHasTwoSubscribersError extends KyuError {
  readonly commandName: string
  readonly firstSubscriptionName: string
  readonly secondSubscriptionName: string

  constructor(commandName: string, firstSubscriptionName: string, secondSubscriptionName: string) {
    super(`command "${commandName}" has two subscribers: "${firstSubscriptionName}" and "${secondSubscriptionName}"`)
    this.name = 'CommandHasTwoSubscribersError'
    this.commandName = commandName
    this.firstSubscriptionName = firstSubscriptionName
    this.secondSubscriptionName = secondSubscriptionName
  }
}

/** `createWorker` refuses a subscription object another worker already bound: `stopDurableWaits` is one-way. */
export class SubscriptionAlreadyBoundError extends KyuError {
  readonly subscriptionName: string
  readonly workerName: string

  constructor(subscriptionName: string, workerName: string) {
    super(
      `subscription "${subscriptionName}" is already bound to another worker and cannot also serve "${workerName}": build one subscription per worker`,
    )
    this.name = 'SubscriptionAlreadyBoundError'
    this.subscriptionName = subscriptionName
    this.workerName = workerName
  }
}

/**
 * A subscribed task rejected the arriving payload: not an envelope, or an
 * envelope with the wrong name or version. Non-retryable — a redelivery of
 * the same bad payload will fail the same way.
 */
export class EnvelopeRejectedError extends NonRetryableError {
  readonly reason: string
  readonly envelopeId: string | undefined

  // NonRetryableError's own constructor takes only a message, so `cause`
  // cannot travel through its `super()` call; set directly instead.
  constructor(reason: string, envelopeId?: string, options?: { cause: Error }) {
    let message = `envelope rejected: ${reason}`
    if (envelopeId !== undefined) {
      message += ` (envelope ${envelopeId})`
    }
    super(message)
    this.name = 'EnvelopeRejectedError'
    this.reason = reason
    this.envelopeId = envelopeId
    if (options !== undefined) this.cause = options.cause
  }
}

/**
 * A durable handler reached `sleepFor`/`waitFor` after its worker began
 * stopping. Retryable on purpose: its worker is shutting down and the durable
 * listener is about to stop, so registering the wait would never settle and
 * would hold `stop()` open; failing the attempt lets the engine re-dispatch
 * the run.
 */
export class WorkerStoppingError extends KyuError {
  constructor() {
    super('worker is stopping; the wait was not registered')
    this.name = 'WorkerStoppingError'
  }
}

/** `schedules.create` refuses a name a cron already carries: remove it first to change its expression. */
export class ScheduleAlreadyExistsError extends KyuError {
  readonly scheduleName: string

  constructor(scheduleName: string) {
    super(`schedule "${scheduleName}" already exists: remove it first to change its cron`)
    this.name = 'ScheduleAlreadyExistsError'
    this.scheduleName = scheduleName
  }
}

/**
 * A schedule tick named a message the runner's `definitions` list does not
 * carry. Non-retryable: the runner will not suddenly know the message on a
 * redelivery.
 */
export class ScheduleMessageUnknownError extends NonRetryableError {
  readonly messageName: string
  readonly messageVersion: number

  constructor(messageName: string, messageVersion: number) {
    super(`schedule tick names ${messageName} v${messageVersion}, which this runner has no definition for`)
    this.name = 'ScheduleMessageUnknownError'
    this.messageName = messageName
    this.messageVersion = messageVersion
  }
}

/**
 * The relay's database handle will never serve another query: a `pg.Client`
 * whose connection dropped, or a client or pool the process already ended.
 * A `Client` cannot reconnect, so the relay stops rather than polling a
 * corpse. Restart the process, or hand `startRelay` a pool, which replaces a
 * dropped connection on the next tick.
 */
export class RelayConnectionLostError extends KyuError {
  constructor(cause: Error) {
    super(`relay stopped: the database connection is gone (${cause.message})`, { cause })
    this.name = 'RelayConnectionLostError'
  }
}
