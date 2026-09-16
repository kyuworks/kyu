import { z } from 'zod'

// <project>.<aggregate>.<verb>, lower case, dots only. Events are past tense,
// commands imperative. Enforced at publish and at subscribe.
export const MESSAGE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*){2,}$/

export const messageNameSchema = z.string().regex(MESSAGE_NAME_PATTERN, {
  message: 'message name must look like project.aggregate.verb in lower case',
})

export const messageKindSchema = z.enum(['event', 'command'])

export const envelopeSchema = z.object({
  id: z.uuidv7(),
  name: messageNameSchema,
  version: z.number().int().positive(),
  kind: messageKindSchema,
  occurredAt: z.iso.datetime({ offset: true }),
  tenantId: z.uuid().nullable(),
  orgUnitId: z.uuid().optional(),
  actorUserId: z.uuid().optional(),
  correlationId: z.uuidv7(),
  causationId: z.uuidv7().optional(),
  source: z.string().min(1),
  data: z.record(z.string(), z.json()),
})

export type MessageKind = z.infer<typeof messageKindSchema>
export type Envelope = z.infer<typeof envelopeSchema>

export function parseEnvelope(input: z.input<typeof envelopeSchema>): Envelope {
  return envelopeSchema.parse(input)
}
