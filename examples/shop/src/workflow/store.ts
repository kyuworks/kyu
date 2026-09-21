import type { Queryable } from '@kyuworks/sdk'
import { z } from 'zod'

export interface EnabledDefinition {
  definitionId: string
  versionId: string
}

const enabledDefinitionRowSchema = z.object({ definition_id: z.uuid(), version_id: z.uuid() })

// The one definition turned on for this tenant, or null when none is (the
// normal case, not an error). shop_workflow_definition_one_enabled_idx
// guarantees at most one row can ever match.
export async function readEnabledDefinition(client: Queryable, tenantId: string): Promise<EnabledDefinition | null> {
  const result = await client.query(
    `SELECT d.id::text AS definition_id, d.current_version_id::text AS version_id
     FROM shop_workflow_definition d
     WHERE d.tenant_id = $1 AND d.enabled AND d.current_version_id IS NOT NULL
     LIMIT 1`,
    [tenantId],
  )
  if (result.rows.length === 0) return null
  const row = enabledDefinitionRowSchema.parse(result.rows[0])
  return { definitionId: row.definition_id, versionId: row.version_id }
}
