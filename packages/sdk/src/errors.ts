import { NonRetryableError } from './hatchet.js'

export { MessageDataError } from '@kinesin/schemas'

/** Base for every SDK-raised error not already covered by the engine's own. */
export class KinesinError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KinesinError'
  }
}

/** `createWorker` refuses two subscriptions to the same command name. */
export class CommandHasTwoSubscribersError extends KinesinError {
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

/**
 * A subscribed task rejected the arriving payload: not an envelope, or an
 * envelope with the wrong name or version. Non-retryable — a redelivery of
 * the same bad payload will fail the same way.
 */
export class EnvelopeRejectedError extends NonRetryableError {
  readonly reason: string
  readonly envelopeId: string | undefined

  constructor(reason: string, envelopeId?: string) {
    let message = `envelope rejected: ${reason}`
    if (envelopeId !== undefined) {
      message = `envelope rejected: ${reason} (envelope ${envelopeId})`
    }
    super(message)
    this.name = 'EnvelopeRejectedError'
    this.reason = reason
    this.envelopeId = envelopeId
  }
}
