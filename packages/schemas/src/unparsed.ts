import type { Envelope } from './envelope.js'
import { envelopeSchema } from './envelope.js'

/** Input from a wire or a database column. The only type that may enter a parse function. */
export type Unparsed = {} | null | undefined

export function parseEnvelope(input: Unparsed): Envelope {
  return envelopeSchema.parse(input)
}

export function parseEnvelopeSafe(
  input: Unparsed,
): { ok: true; envelope: Envelope } | { ok: false; issues: ReadonlyArray<{ path: string; message: string }> } {
  const result = envelopeSchema.safeParse(input)
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    }
  }
  return { ok: true, envelope: result.data }
}
