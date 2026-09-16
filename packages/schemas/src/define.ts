import type { StandardSchemaV1 } from '@standard-schema/spec'
import { z } from 'zod'
import type { MessageKind } from './envelope.js'
import { messageNameSchema } from './envelope.js'

export interface MessageDefinition<TData> {
  name: string
  version: number
  kind: MessageKind
  data: StandardSchemaV1<unknown, TData>
}

export type MessageData<TDefinition extends MessageDefinition<unknown>> =
  TDefinition extends MessageDefinition<infer TData> ? TData : never

interface DefineMessageSpec<TData> {
  name: string
  version?: number
  data: StandardSchemaV1<unknown, TData>
}

const messageVersionSchema = z.number().int().positive()

function defineMessage<TData>(spec: DefineMessageSpec<TData>, kind: MessageKind): MessageDefinition<TData> {
  if (!messageNameSchema.safeParse(spec.name).success) {
    throw new Error(
      `invalid message name "${spec.name}": message name must look like project.aggregate.verb in lower case`,
    )
  }
  const version = spec.version ?? 1
  if (!messageVersionSchema.safeParse(version).success) {
    throw new Error(`invalid message version for "${spec.name}": version must be a positive integer, got ${version}`)
  }
  return { name: spec.name, version, kind, data: spec.data }
}

export function defineEvent<TData>(spec: DefineMessageSpec<TData>): MessageDefinition<TData> {
  return defineMessage(spec, 'event')
}

export function defineCommand<TData>(spec: DefineMessageSpec<TData>): MessageDefinition<TData> {
  return defineMessage(spec, 'command')
}
