import { KinesinError, NonRetryableError } from './hatchet.js'

export { EnvelopeOptionsError, MessageDataError, MessageDefinitionError } from '@kinesin/schemas'
export type { EnvelopeOptionIssue, MessageDataIssue } from '@kinesin/schemas'
export { KinesinError } from './hatchet.js'

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
      message += ` (envelope ${envelopeId})`
    }
    super(message)
    this.name = 'EnvelopeRejectedError'
    this.reason = reason
    this.envelopeId = envelopeId
  }
}
