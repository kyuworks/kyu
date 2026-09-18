import { envelopeSchema } from '@qtaxis/schemas'
import { z } from 'zod'

// Shapes as `pg` returns them: timestamptz columns decode to Date, uuid to
// string, jsonb to a parsed value re-validated against the envelope contract.
export const outboxRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  tenant_id: z.uuid().nullable(),
  envelope: envelopeSchema,
  created_at: z.date(),
  claimed_at: z.date().nullable(),
  claimed_by: z.string().nullable(),
  published_at: z.date().nullable(),
  attempts: z.number().int(),
  last_error: z.string().nullable(),
})

export type OutboxRow = z.infer<typeof outboxRowSchema>

export const processedRowSchema = z.object({
  envelope_id: z.uuid(),
  handler: z.string(),
  processed_at: z.date(),
})

export type ProcessedRow = z.infer<typeof processedRowSchema>
