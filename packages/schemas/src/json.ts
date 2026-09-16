// Shared by define.ts (message data shape) and envelope.ts (the generic
// envelope's default). Kept separate so neither imports the other.
export type JsonPrimitive = string | number | boolean | null

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject

// `| undefined` lets an optional zod field typecheck; createEnvelope strips it before the wire sees it.
export interface JsonObject {
  [key: string]: JsonValue | undefined
}

export type MessageDataShape = JsonObject
