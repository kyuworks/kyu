import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { BRANCH_FLOW, DURATION_FLOW, ORDER_FOLLOW_UP_FLOW } from './crmFlowFixtures.js'

export interface WorkflowFixtureSteps {
  waitSeconds: number
  settleSeconds: number
  notifyText: string
}

const DEFAULT_STEPS: WorkflowFixtureSteps = {
  waitSeconds: 3,
  settleSeconds: 5,
  notifyText: 'Order has not shipped yet — please chase the warehouse.',
}

// workflow/definition.ts's schema, inline: wait-a-bit delay -> shipped-yet
// branch -> (false) settle delay -> nudge notify -> finish; (true) finish.
function buildDefinition(steps: WorkflowFixtureSteps) {
  return {
    schemaVersion: 1,
    start: 'wait-a-bit',
    steps: [
      { id: 'wait-a-bit', kind: 'delay', input: { seconds: steps.waitSeconds }, next: 'shipped-yet' },
      {
        id: 'shipped-yet',
        kind: 'branch',
        input: { condition: 'order-shipped' },
        whenTrue: 'finish',
        whenFalse: 'settle',
      },
      { id: 'settle', kind: 'delay', input: { seconds: steps.settleSeconds }, next: 'nudge' },
      { id: 'nudge', kind: 'notify', input: { text: steps.notifyText }, next: 'finish' },
      { id: 'finish', kind: 'end' },
    ],
  }
}

export interface InsertedDefinition {
  definitionId: string
  versionId: string
}

// The smallest fixture that makes run-workflow find something to walk: one
// enabled definition, one version, for a fresh random tenant.
// shop_workflow_definition and shop_workflow_version are never truncated
// (vitest.integration.clearTables.ts), so this grows both tables by one row per test.
export async function insertWorkflowDefinition(
  admin: Client,
  tenantId: string,
  steps: WorkflowFixtureSteps = DEFAULT_STEPS,
): Promise<InsertedDefinition> {
  const definitionId = randomUUID()
  const versionId = randomUUID()
  await admin.query(
    'INSERT INTO shop_workflow_definition (id, tenant_id, name, enabled, current_version_id) VALUES ($1, $2, $3, false, NULL)',
    [definitionId, tenantId, 'proof-workflow'],
  )
  await admin.query(
    'INSERT INTO shop_workflow_version (id, definition_id, tenant_id, version, steps) VALUES ($1, $2, $3, 1, $4)',
    [versionId, definitionId, tenantId, JSON.stringify(buildDefinition(steps))],
  )
  await admin.query('UPDATE shop_workflow_definition SET enabled = true, current_version_id = $2 WHERE id = $1', [
    definitionId,
    versionId,
  ])
  return { definitionId, versionId }
}

// stepIdSchema allows a step literally named "start" (workflow/definition.ts).
// This definition's one step is a notify named "start", to prove run-workflow's
// run-start guard and that step's own onceById guard use different keys.
function buildStepIdCollisionDefinition(notifyText: string) {
  return {
    schemaVersion: 1,
    start: 'start',
    steps: [
      { id: 'start', kind: 'notify', input: { text: notifyText }, next: 'finish' },
      { id: 'finish', kind: 'end' },
    ],
  }
}

export async function insertStepIdCollisionDefinition(
  admin: Client,
  tenantId: string,
  notifyText = 'Order has not shipped yet — please chase the warehouse.',
): Promise<InsertedDefinition> {
  const definitionId = randomUUID()
  const versionId = randomUUID()
  await admin.query(
    'INSERT INTO shop_workflow_definition (id, tenant_id, name, enabled, current_version_id) VALUES ($1, $2, $3, false, NULL)',
    [definitionId, tenantId, 'step-id-collision'],
  )
  await admin.query(
    'INSERT INTO shop_workflow_version (id, definition_id, tenant_id, version, steps) VALUES ($1, $2, $3, 1, $4)',
    [versionId, definitionId, tenantId, JSON.stringify(buildStepIdCollisionDefinition(notifyText))],
  )
  await admin.query('UPDATE shop_workflow_definition SET enabled = true, current_version_id = $2 WHERE id = $1', [
    definitionId,
    versionId,
  ])
  return { definitionId, versionId }
}

// One long delay, one notify, one end: the smallest definition that must
// hand its wait to a scheduled publish (#113).
export async function insertLongDelayDefinition(
  admin: Client,
  tenantId: string,
  delaySeconds: number,
  notifyText = 'The long wait is over — chase the warehouse.',
): Promise<InsertedDefinition> {
  const definitionId = randomUUID()
  const versionId = randomUUID()
  const steps = {
    schemaVersion: 1,
    start: 'hold',
    steps: [
      { id: 'hold', kind: 'delay', input: { seconds: delaySeconds }, next: 'nudge' },
      { id: 'nudge', kind: 'notify', input: { text: notifyText }, next: 'finish' },
      { id: 'finish', kind: 'end' },
    ],
  }
  await admin.query(
    'INSERT INTO shop_workflow_definition (id, tenant_id, name, enabled, current_version_id) VALUES ($1, $2, $3, false, NULL)',
    [definitionId, tenantId, 'long-delay'],
  )
  await admin.query(
    'INSERT INTO shop_workflow_version (id, definition_id, tenant_id, version, steps) VALUES ($1, $2, $3, 1, $4)',
    [versionId, definitionId, tenantId, JSON.stringify(steps)],
  )
  await admin.query('UPDATE shop_workflow_definition SET enabled = true, current_version_id = $2 WHERE id = $1', [
    definitionId,
    versionId,
  ])
  return { definitionId, versionId }
}

// Two delay steps back to back: a short one, then a long one, then a notify
// and an end. The harness's cancel-between-steps scenario waits for the
// short step's ledger row (proof the run is past its first step) and cancels
// while the run is genuinely parked in the second step's sleepFor, before it
// ever reaches the notify.
export async function insertTwoDelayWorkflowDefinition(
  admin: Client,
  tenantId: string,
  firstDelaySeconds: number,
  secondDelaySeconds: number,
  notifyText = 'Order has not shipped yet — please chase the warehouse.',
): Promise<InsertedDefinition> {
  const definitionId = randomUUID()
  const versionId = randomUUID()
  const steps = {
    schemaVersion: 1,
    start: 'first',
    steps: [
      { id: 'first', kind: 'delay', input: { seconds: firstDelaySeconds }, next: 'hold' },
      { id: 'hold', kind: 'delay', input: { seconds: secondDelaySeconds }, next: 'nudge' },
      { id: 'nudge', kind: 'notify', input: { text: notifyText }, next: 'finish' },
      { id: 'finish', kind: 'end' },
    ],
  }
  await admin.query(
    'INSERT INTO shop_workflow_definition (id, tenant_id, name, enabled, current_version_id) VALUES ($1, $2, $3, false, NULL)',
    [definitionId, tenantId, 'two-delay'],
  )
  await admin.query(
    'INSERT INTO shop_workflow_version (id, definition_id, tenant_id, version, steps) VALUES ($1, $2, $3, 1, $4)',
    [versionId, definitionId, tenantId, JSON.stringify(steps)],
  )
  await admin.query('UPDATE shop_workflow_definition SET enabled = true, current_version_id = $2 WHERE id = $1', [
    definitionId,
    versionId,
  ])
  return { definitionId, versionId }
}

// The order follow-up flow, stored as written (issue #157).
export async function insertCrmFlowDefinition(admin: Client, tenantId: string): Promise<InsertedDefinition> {
  const definitionId = randomUUID()
  const versionId = randomUUID()
  await admin.query(
    'INSERT INTO shop_workflow_definition (id, tenant_id, name, enabled, current_version_id) VALUES ($1, $2, $3, false, NULL)',
    [definitionId, tenantId, 'crm-order-follow-up'],
  )
  await admin.query(
    'INSERT INTO shop_workflow_version (id, definition_id, tenant_id, version, steps) VALUES ($1, $2, $3, 1, $4)',
    [versionId, definitionId, tenantId, JSON.stringify(ORDER_FOLLOW_UP_FLOW)],
  )
  await admin.query('UPDATE shop_workflow_definition SET enabled = true, current_version_id = $2 WHERE id = $1', [
    definitionId,
    versionId,
  ])
  return { definitionId, versionId }
}

// The branch fixture, stored as written (issue #157 PR B).
export async function insertCrmBranchDefinition(admin: Client, tenantId: string): Promise<InsertedDefinition> {
  const definitionId = randomUUID()
  const versionId = randomUUID()
  await admin.query(
    'INSERT INTO shop_workflow_definition (id, tenant_id, name, enabled, current_version_id) VALUES ($1, $2, $3, false, NULL)',
    [definitionId, tenantId, 'crm-branch'],
  )
  await admin.query(
    'INSERT INTO shop_workflow_version (id, definition_id, tenant_id, version, steps) VALUES ($1, $2, $3, 1, $4)',
    [versionId, definitionId, tenantId, JSON.stringify(BRANCH_FLOW)],
  )
  await admin.query('UPDATE shop_workflow_definition SET enabled = true, current_version_id = $2 WHERE id = $1', [
    definitionId,
    versionId,
  ])
  return { definitionId, versionId }
}

// The duration-wait fixture, stored as written (issue #157 PR B).
export async function insertCrmDurationDefinition(admin: Client, tenantId: string): Promise<InsertedDefinition> {
  const definitionId = randomUUID()
  const versionId = randomUUID()
  await admin.query(
    'INSERT INTO shop_workflow_definition (id, tenant_id, name, enabled, current_version_id) VALUES ($1, $2, $3, false, NULL)',
    [definitionId, tenantId, 'crm-duration-wait'],
  )
  await admin.query(
    'INSERT INTO shop_workflow_version (id, definition_id, tenant_id, version, steps) VALUES ($1, $2, $3, 1, $4)',
    [versionId, definitionId, tenantId, JSON.stringify(DURATION_FLOW)],
  )
  await admin.query('UPDATE shop_workflow_definition SET enabled = true, current_version_id = $2 WHERE id = $1', [
    definitionId,
    versionId,
  ])
  return { definitionId, versionId }
}

export interface InsertLeadProjectionInput {
  tenantId: string
  orderId: string
  scoreBand: 'hot' | 'warm' | 'cold'
}

// Eleven fields fixed, only scoreBand varies: the branch fixture's one
// condition is the only field either test reads (workflow/crmFlowConditions.ts).
const DEFAULT_LEAD_PROJECTION = {
  channel: 'web',
  source: 'organic',
  stageCode: 'new',
  score: 60,
  orgUnitId: null,
  assigned: false,
  isTerminal: false,
  hasMobile: true,
  hasEmail: true,
  isBusinessHours: true,
  conversationState: 'none',
} as const

export async function insertLeadProjection(admin: Client, input: InsertLeadProjectionInput): Promise<void> {
  const projection = { ...DEFAULT_LEAD_PROJECTION, scoreBand: input.scoreBand }
  await admin.query('INSERT INTO shop_lead_projection (tenant_id, order_id, projection) VALUES ($1, $2, $3)', [
    input.tenantId,
    input.orderId,
    JSON.stringify(projection),
  ])
}

// A second saved version, repointed as current: proves a parked run keeps
// walking the version it pinned at the start, not this one (version-pin-holds).
export async function insertNewVersion(
  admin: Client,
  definition: InsertedDefinition,
  tenantId: string,
  steps: WorkflowFixtureSteps,
): Promise<string> {
  const versionId = randomUUID()
  await admin.query(
    'INSERT INTO shop_workflow_version (id, definition_id, tenant_id, version, steps) VALUES ($1, $2, $3, 2, $4)',
    [versionId, definition.definitionId, tenantId, JSON.stringify(buildDefinition(steps))],
  )
  await admin.query('UPDATE shop_workflow_definition SET current_version_id = $2 WHERE id = $1', [
    definition.definitionId,
    versionId,
  ])
  return versionId
}
