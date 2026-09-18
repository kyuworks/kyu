import type { Envelope, MessageName } from '@qtaxis/schemas'
import { toEnvelopeMetadata } from '@qtaxis/schemas'
import { eventScope } from '../eventScope.js'
import type { OutboxRow } from '../outbox/rows.js'

/** One `bulkPush` array element; `scope` is the tenant id, or `'global'` for a tenant-less envelope. */
export interface PushItem {
  payload: Envelope
  additionalMetadata: Record<string, string>
  scope: string
}

// `bulkPush` takes one event key per call, so rows are grouped by name, keeping publish order within a name.
export function groupEnvelopesForPush(rows: readonly OutboxRow[]): Map<MessageName, PushItem[]> {
  const groups = new Map<MessageName, PushItem[]>()
  for (const row of rows) {
    const { envelope } = row
    const item: PushItem = {
      payload: envelope,
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: eventScope(envelope),
    }
    const group = groups.get(envelope.name)
    if (group === undefined) {
      groups.set(envelope.name, [item])
    } else {
      group.push(item)
    }
  }
  return groups
}
