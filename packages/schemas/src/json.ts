// Shared by define.ts (message data shape) and envelope.ts (the generic
// envelope's default). Kept separate so neither imports the other.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type MessageDataShape = { [key: string]: JsonValue }
