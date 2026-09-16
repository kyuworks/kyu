import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { MessageKind, MessageName } from './envelope.js'
import { messageNameSchema, messageVersionSchema } from './envelope.js'
import { MessageDefinitionError } from './errors.js'
import type { MessageDataShape } from './json.js'

export type { JsonValue, MessageDataShape } from './json.js'

export interface MessageDefinition<TData extends MessageDataShape> {
  name: MessageName
  version: number
  kind: MessageKind
  data: StandardSchemaV1<unknown, TData>
}

export type MessageData<TDefinition extends MessageDefinition<MessageDataShape>> =
  TDefinition extends MessageDefinition<infer TData> ? TData : never

interface DefineMessageSpec<TData extends MessageDataShape> {
  name: MessageName
  version: number
  data: StandardSchemaV1<unknown, TData>
}

function defineMessage<TData extends MessageDataShape>(
  spec: DefineMessageSpec<TData>,
  kind: MessageKind,
): MessageDefinition<TData> {
  if (!messageNameSchema.safeParse(spec.name).success) {
    throw new MessageDefinitionError(
      `invalid message name "${spec.name}": message name must look like project.aggregate.verb in lower case`,
    )
  }
  if (!messageVersionSchema.safeParse(spec.version).success) {
    throw new MessageDefinitionError(
      `invalid message version for "${spec.name}": version must be a positive integer, got ${spec.version}`,
    )
  }
  return { name: spec.name, version: spec.version, kind, data: spec.data }
}

export function defineEvent<TData extends MessageDataShape>(spec: DefineMessageSpec<TData>): MessageDefinition<TData> {
  return defineMessage(spec, 'event')
}

export function defineCommand<TData extends MessageDataShape>(
  spec: DefineMessageSpec<TData>,
): MessageDefinition<TData> {
  return defineMessage(spec, 'command')
}
