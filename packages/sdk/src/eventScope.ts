import type { Envelope } from '@kyuworks/schemas'

// Shared by the relay push (toEvents.ts) and durable waitFor's default
// (consume/waitMatch.ts) so the engine event scope never diverges between them.
export function eventScope(envelope: Pick<Envelope, 'tenantId'>): string {
  return envelope.tenantId ?? 'global'
}
