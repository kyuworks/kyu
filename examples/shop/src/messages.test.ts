import { createEnvelope, uuidv7 } from '@kyuworks/sdk'
import { describe, expect, it } from 'vitest'
import { notifyStaff, orderPlaced, orderShipped, sendInvoice, workflowTriggered } from './messages.js'

describe('messages', () => {
  it('defines the two events and the command, all at version 1', () => {
    expect(orderPlaced.kind).toBe('event')
    expect(orderPlaced.name).toBe('shop.order.placed')
    expect(orderPlaced.version).toBe(1)
    expect(orderShipped.kind).toBe('event')
    expect(orderShipped.name).toBe('shop.order.shipped')
    expect(orderShipped.version).toBe(1)
    expect(sendInvoice.kind).toBe('command')
    expect(sendInvoice.name).toBe('shop.invoice.send')
    expect(sendInvoice.version).toBe(1)
  })

  it('defines workflowTriggered as an event and notifyStaff as a command, both at version 1', () => {
    expect(workflowTriggered.kind).toBe('event')
    expect(workflowTriggered.name).toBe('shop.workflow.triggered')
    expect(workflowTriggered.version).toBe(1)
    expect(notifyStaff.kind).toBe('command')
    expect(notifyStaff.name).toBe('shop.staff.notify')
    expect(notifyStaff.version).toBe(1)
  })

  it('rejects data that fails its schema for orderPlaced', async () => {
    await expect(
      createEnvelope(
        orderPlaced,
        { orderId: 'not-a-uuid', customerId: uuidv7() },
        { tenantId: uuidv7(), source: 'test' },
      ),
    ).rejects.toThrow()
  })

  it('rejects data that fails its schema for orderShipped', async () => {
    await expect(
      createEnvelope(orderShipped, { orderId: 'not-a-uuid', carrier: 'ups' }, { tenantId: uuidv7(), source: 'test' }),
    ).rejects.toThrow()
  })

  it('rejects data that fails its schema for sendInvoice', async () => {
    await expect(
      createEnvelope(
        sendInvoice,
        { orderId: 'not-a-uuid', invoiceId: uuidv7() },
        { tenantId: uuidv7(), source: 'test' },
      ),
    ).rejects.toThrow()
  })

  it('rejects data that fails its schema for workflowTriggered', async () => {
    await expect(
      createEnvelope(
        workflowTriggered,
        { runId: uuidv7(), definitionId: 'not-a-uuid', versionId: uuidv7(), orderId: uuidv7() },
        { tenantId: uuidv7(), source: 'test' },
      ),
    ).rejects.toThrow()
  })

  it('accepts workflowTriggered data with a resumeStepId and rejects an invalid one (#113)', async () => {
    await expect(
      createEnvelope(
        workflowTriggered,
        { runId: uuidv7(), definitionId: uuidv7(), versionId: uuidv7(), orderId: uuidv7(), resumeStepId: 'nudge' },
        { tenantId: uuidv7(), source: 'test' },
      ),
    ).resolves.toBeDefined()
    await expect(
      createEnvelope(
        workflowTriggered,
        {
          runId: uuidv7(),
          definitionId: uuidv7(),
          versionId: uuidv7(),
          orderId: uuidv7(),
          resumeStepId: 'NOT A STEP',
        },
        { tenantId: uuidv7(), source: 'test' },
      ),
    ).rejects.toThrow()
  })

  it('rejects data that fails its schema for notifyStaff', async () => {
    await expect(
      createEnvelope(
        notifyStaff,
        { runId: uuidv7(), versionId: uuidv7(), stepId: '', orderId: uuidv7() },
        { tenantId: uuidv7(), source: 'test' },
      ),
    ).rejects.toThrow()
  })
})
