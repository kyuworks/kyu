import type { Publisher } from '@kyuworks/sdk'
import { uuidv7 } from '@kyuworks/sdk'
import type { PoolClient } from 'pg'
import { workflowTriggered } from '../messages.js'
import { readEnabledDefinition } from '../workflow/store.js'

export interface TriggerWorkflowInput {
  tenantId: string
  orderId: string
}

export interface TriggeredWorkflow {
  runId: string
  versionId: string
  envelopeId: string
}

// Interior: runs on the caller's client, inside the caller's transaction, so
// the trigger commits with the order or not at all. Returns null when this
// tenant has no enabled definition — the normal case, not an error.
export async function triggerWorkflowOn(
  client: PoolClient,
  publisher: Publisher,
  input: TriggerWorkflowInput,
): Promise<TriggeredWorkflow | null> {
  const enabled = await readEnabledDefinition(client, input.tenantId)
  if (enabled === null) return null

  // The run id is minted here, is the correlationId of the trigger and of
  // every command the run publishes, and keys every ledger row and every
  // onceById marker. uuid v7 because envelopeSchema.correlationId requires it.
  const runId = uuidv7()
  const envelope = await publisher.publish(
    client,
    workflowTriggered,
    { runId, definitionId: enabled.definitionId, versionId: enabled.versionId, orderId: input.orderId },
    { tenantId: input.tenantId, correlationId: runId },
  )
  return { runId, versionId: enabled.versionId, envelopeId: envelope.id }
}
