import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { MessageKind, MessageName } from './envelope.js'
import { messageNameSchema, messageVersionSchema } from './envelope.js'
import { MessageDefinitionError } from './errors.js'
import type { MessageDataShape } from './json.js'

export type { JsonObject, JsonPrimitive, JsonValue, MessageDataShape } from './json.js'

// Input is fixed to `unknown` by the Standard Schema spec (`validate` always takes `unknown`);
// only Output is a Kinesin-chosen constraint here.
export type MessageSchema = StandardSchemaV1<unknown, MessageDataShape>

export interface MessageDefinition<S extends MessageSchema = MessageSchema> {
  readonly name: MessageName
  readonly version: number
  readonly kind: MessageKind
  readonly data: S
}

/** What a caller passes in for `data`, before the definition's schema parses or transforms it. */
export type MessageInput<TDefinition> =
  TDefinition extends MessageDefinition<infer S> ? StandardSchemaV1.InferInput<S> : never

/** What an envelope carries for `data`, after the definition's schema parses or transforms it. */
export type MessageData<TDefinition> =
  TDefinition extends MessageDefinition<infer S> ? StandardSchemaV1.InferOutput<S> : never

interface DefineMessageSpec<S extends MessageSchema> {
  name: MessageName
  version: number
  data: S
}

function defineMessage<S extends MessageSchema>(spec: DefineMessageSpec<S>, kind: MessageKind): MessageDefinition<S> {
  if (!messageNameSchema.safeParse(spec.name).success) {
    throw new MessageDefinitionError(
      `invalid message name "${spec.name}": message name must be exactly project.aggregate.verb in lower case`,
    )
  }
  if (!messageVersionSchema.safeParse(spec.version).success) {
    throw new MessageDefinitionError(
      `invalid message version for "${spec.name}": version must be a positive integer, got ${spec.version}`,
    )
  }
  return { name: spec.name, version: spec.version, kind, data: spec.data }
}

export function defineEvent<S extends MessageSchema>(spec: DefineMessageSpec<S>): MessageDefinition<S> {
  return defineMessage(spec, 'event')
}

export function defineCommand<S extends MessageSchema>(spec: DefineMessageSpec<S>): MessageDefinition<S> {
  return defineMessage(spec, 'command')
}
