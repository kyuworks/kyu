import type { Queryable, RelayQueryable, Unparsed } from '@kyuworks/sdk'
import { NonRetryableError } from '@kyuworks/sdk'
import { z } from 'zod'
import { parseWorkflowDefinition, stepById } from './definition.js'
import type { WorkflowDefinition, WorkflowStep } from './definition.js'

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

// steps is jsonb, unparsed until parseWorkflowDefinition (the trust edge for
// a stored definition) validates it below; z.custom carries that
// unvalidated value through with no assertion.
const rawStepsSchema = z.custom<Unparsed>()
const versionRowSchema = z.object({ steps: rawStepsSchema })

export interface PinnedVersion {
  definitionId: string
  versionId: string
  definition: WorkflowDefinition
}

export interface LoadPinnedVersionInput {
  tenantId: string
  definitionId: string
  versionId: string
}

// Loaded fresh on every run, never cached: the interpreter never reads
// shop_workflow_definition.current_version_id, only the version a run pinned
// at its start (ADR decision 4).
export async function loadPinnedVersion(client: RelayQueryable, input: LoadPinnedVersionInput): Promise<PinnedVersion> {
  const result = await client.query(
    'SELECT steps FROM shop_workflow_version WHERE id = $1 AND definition_id = $2 AND tenant_id = $3',
    [input.versionId, input.definitionId, input.tenantId],
  )
  if (result.rows.length === 0) {
    throw new NonRetryableError(
      `no shop_workflow_version row for version ${input.versionId} of definition ${input.definitionId} in tenant ${input.tenantId}`,
    )
  }
  const row = versionRowSchema.parse(result.rows[0])
  return {
    definitionId: input.definitionId,
    versionId: input.versionId,
    definition: parseWorkflowDefinition(row.steps),
  }
}

export interface InsertRunInput {
  runId: string
  tenantId: string
  definitionId: string
  versionId: string
  orderId: string
  triggerEnvelopeId: string
}

// The one row per run, written before the first step (runWorkflow.ts) so a
// concurrent second trigger for the same order is a distinct run, never a merge.
export async function insertRun(client: Queryable, input: InsertRunInput): Promise<void> {
  await client.query(
    `INSERT INTO shop_workflow_run (run_id, tenant_id, definition_id, version_id, order_id, trigger_envelope_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.runId, input.tenantId, input.definitionId, input.versionId, input.orderId, input.triggerEnvelopeId],
  )
}

export async function finishRun(client: Queryable, runId: string): Promise<void> {
  await client.query('UPDATE shop_workflow_run SET finished_at = now() WHERE run_id = $1', [runId])
}

export interface RecordStepInput {
  runId: string
  stepId: string
  tenantId: string
  kind: WorkflowStep['kind']
  exitStepId: string | null
}

// One row per step a run has finished; shop_workflow_step_log's primary key
// (run_id, step_id) turns a second walk of one step into a database error.
export async function recordStep(client: Queryable, input: RecordStepInput): Promise<void> {
  await client.query(
    'INSERT INTO shop_workflow_step_log (run_id, step_id, tenant_id, kind, exit_step_id) VALUES ($1, $2, $3, $4, $5)',
    [input.runId, input.stepId, input.tenantId, input.kind, input.exitStepId],
  )
}

/** No row (never walked) and a row with a null exit (an `end` step) are different results. */
export type StepExit = { found: false } | { found: true; exitStepId: string | null }

const stepExitRowSchema = z.object({ exit_step_id: z.string().nullable() })

// A branch reads its own recorded exit here before deciding again, so a
// replay reuses the exit the run already took (ADR decision 7).
export async function readStepExit(client: RelayQueryable, runId: string, stepId: string): Promise<StepExit> {
  const result = await client.query(
    'SELECT exit_step_id FROM shop_workflow_step_log WHERE run_id = $1 AND step_id = $2',
    [runId, stepId],
  )
  if (result.rows.length === 0) return { found: false }
  const row = stepExitRowSchema.parse(result.rows[0])
  return { found: true, exitStepId: row.exit_step_id }
}

const shippedRowSchema = z.object({ shipped_at: z.date().nullable() })

// The one branch condition this interpreter knows (workflow/definition.ts's
// `order-shipped` literal): a condition is interpreter code, not a definition edit.
export async function isOrderShipped(client: RelayQueryable, tenantId: string, orderId: string): Promise<boolean> {
  const result = await client.query('SELECT shipped_at FROM shop_order WHERE id = $1 AND tenant_id = $2', [
    orderId,
    tenantId,
  ])
  if (result.rows.length === 0) {
    throw new NonRetryableError(`no shop_order row for order ${orderId} in tenant ${tenantId}`)
  }
  const row = shippedRowSchema.parse(result.rows[0])
  return row.shipped_at !== null
}

export interface ReadNotifyTextInput {
  tenantId: string
  versionId: string
  stepId: string
}

// notify-staff only carries the version id and the step id (no definition
// id), so this loads the version directly rather than through loadPinnedVersion.
export async function readNotifyText(client: RelayQueryable, input: ReadNotifyTextInput): Promise<string> {
  const result = await client.query('SELECT steps FROM shop_workflow_version WHERE id = $1 AND tenant_id = $2', [
    input.versionId,
    input.tenantId,
  ])
  if (result.rows.length === 0) {
    throw new NonRetryableError(
      `no shop_workflow_version row for version ${input.versionId} in tenant ${input.tenantId}`,
    )
  }
  const row = versionRowSchema.parse(result.rows[0])
  const definition = parseWorkflowDefinition(row.steps)
  const step = stepById(definition, input.stepId)
  if (step.kind !== 'notify') {
    throw new NonRetryableError(`step ${input.stepId} of version ${input.versionId} is not a notify step`)
  }
  return step.input.text
}
