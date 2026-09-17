import { EnvelopeMetadataError, fromEnvelopeMetadata, parseEnvelopeSafe, validateStandard } from '@kinesin/schemas'
import type {
  Envelope,
  EnvelopeMetadataFields,
  MessageData,
  MessageDataShape,
  MessageDefinition,
  MessageKind,
  MessageSchema,
  Unparsed,
} from '@kinesin/schemas'
import { EnvelopeRejectedError } from '../errors.js'
import type { Context, CreateTaskWorkflowOpts, HatchetClient, JsonObject, TaskWorkflowDeclaration } from '../hatchet.js'
import { buildHandlerContext } from './handlerContext.js'
import type { HandlerContext } from './handlerContext.js'
import { applySharedTaskOptions } from './taskOptions.js'
import type { SharedTaskOptions } from './taskOptions.js'

export interface SubscribeOptions<TData extends MessageDataShape> extends SharedTaskOptions {
  name: string
  handler: (ctx: HandlerContext<TData>) => Promise<void> | void
}

export interface Subscription {
  name: string
  kind: MessageKind
  messageName: string
  workflow: TaskWorkflowDeclaration
}

// Every mismatch is an `EnvelopeRejectedError`, non-retryable: redelivering
// the same bad payload fails the same way.
export async function decodeIncomingEnvelope<S extends MessageSchema>(
  definition: MessageDefinition<S>,
  input: Unparsed,
): Promise<Envelope<MessageData<MessageDefinition<S>>>> {
  const parsed = parseEnvelopeSafe(input)
  if (!parsed.ok) {
    const summary = parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    throw new EnvelopeRejectedError(`payload does not match the envelope schema: ${summary}`)
  }

  const envelope = parsed.envelope
  if (
    envelope.name !== definition.name ||
    envelope.version !== definition.version ||
    envelope.kind !== definition.kind
  ) {
    throw new EnvelopeRejectedError(
      `expected ${definition.kind} ${definition.name} v${definition.version}, got ${envelope.kind} ${envelope.name} v${envelope.version}`,
      envelope.id,
    )
  }

  try {
    const data = await validateStandard(definition.data, envelope.data)
    return { ...envelope, data }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'message data failed validation'
    throw new EnvelopeRejectedError(reason, envelope.id)
  }
}

// The trust edge for the engine's string metadata map: metadata that does not
// describe its own payload never comes from `publish()`, so it is rejected.
export function decodeAndCheckMetadata(
  hatchetContext: Context<JsonObject>,
  envelope: Envelope<MessageDataShape>,
): EnvelopeMetadataFields {
  let metadata: EnvelopeMetadataFields
  try {
    metadata = fromEnvelopeMetadata(hatchetContext.additionalMetadata())
  } catch (cause) {
    if (!(cause instanceof EnvelopeMetadataError)) throw cause
    throw new EnvelopeRejectedError(cause.message, envelope.id, { cause })
  }
  if (metadata.envelopeId !== envelope.id) {
    throw new EnvelopeRejectedError(
      `additionalMetadata envelopeId ${metadata.envelopeId} does not match envelope id ${envelope.id}`,
      envelope.id,
    )
  }
  if (metadata.tenantId !== envelope.tenantId) {
    throw new EnvelopeRejectedError(
      `additionalMetadata tenantId ${String(metadata.tenantId)} does not match envelope tenantId ${String(envelope.tenantId)}`,
      envelope.id,
    )
  }
  return metadata
}

async function runHandler<S extends MessageSchema>(
  definition: MessageDefinition<S>,
  handler: SubscribeOptions<MessageData<MessageDefinition<S>>>['handler'],
  input: JsonObject,
  hatchetContext: Context<JsonObject>,
): Promise<void> {
  // Not caught here: a throw retries, an `EnvelopeRejectedError` does not.
  const envelope = await decodeIncomingEnvelope(definition, input)
  const metadata = decodeAndCheckMetadata(hatchetContext, envelope)
  await handler(buildHandlerContext(envelope, metadata, hatchetContext))
}

export function subscribe<S extends MessageSchema>(
  hatchet: HatchetClient,
  definition: MessageDefinition<S>,
  options: SubscribeOptions<MessageData<MessageDefinition<S>>>,
): Subscription {
  const taskOptions: CreateTaskWorkflowOpts<JsonObject, void> = {
    name: options.name,
    onEvents: [definition.name],
    fn: (input: JsonObject, ctx: Context<JsonObject>) => runHandler(definition, options.handler, input, ctx),
  }

  applySharedTaskOptions(taskOptions, options)

  const workflow = hatchet.task<JsonObject, void>(taskOptions)

  return { name: options.name, kind: definition.kind, messageName: definition.name, workflow }
}
