import { defineCommand, defineEvent } from '@kyuworks/sdk'
import { z } from 'zod'
import { workflowNodeIdSchema } from './workflow/definition.js'

export const orderPlaced = defineEvent({
  name: 'shop.order.placed',
  version: 1,
  data: z.object({ orderId: z.uuid(), customerId: z.uuid() }),
})

export const orderShipped = defineEvent({
  name: 'shop.order.shipped',
  version: 1,
  data: z.object({ orderId: z.uuid(), carrier: z.string().min(1) }),
})

export const sendInvoice = defineCommand({
  name: 'shop.invoice.send',
  version: 1,
  data: z.object({ orderId: z.uuid(), invoiceId: z.uuid() }),
})

// The shop's own seam publishes this when an order is placed, for the one
// definition enabled for the tenant. Ids only: the run id and the pinned
// version id, never a step's authored text.
export const workflowTriggered = defineEvent({
  name: 'shop.workflow.triggered',
  version: 1,
  data: z.object({
    runId: z.uuidv7(),
    definitionId: z.uuid(),
    versionId: z.uuid(),
    orderId: z.uuid(),
    // Set only on a continuation the interpreter scheduled for itself at a long
    // delay's wake time: the step or node the new run walks from (#113, #157).
    resumeStepId: workflowNodeIdSchema.optional(),
  }),
})

// Published by one notify step. The text lives in the pinned
// version; this carries the ids that find it.
export const notifyStaff = defineCommand({
  name: 'shop.staff.notify',
  version: 1,
  // stepId reuses workflow/definition.ts's workflowNodeIdSchema: a shop step
  // id or a CRM flow node id, one rule (#157).
  data: z.object({ runId: z.uuidv7(), versionId: z.uuid(), stepId: workflowNodeIdSchema, orderId: z.uuid() }),
})
