import { describe, expect, it } from 'vitest'
import { NonRetryableError } from '@kyuworks/sdk'
import { flowNodeById, flowNodeExits } from './crmFlowDefinition.js'
import type { FlowActionNode } from './crmFlowDefinition.js'
import { parseStoredWorkflow } from './definition.js'
import { BRANCH_FLOW, DURATION_FLOW, ORDER_FOLLOW_UP_FLOW } from '../__tests__/crmFlowFixtures.js'

const SHOP_DEFINITION = {
  schemaVersion: 1,
  start: 'wait-a-bit',
  steps: [
    { id: 'wait-a-bit', kind: 'delay', input: { seconds: 3 }, next: 'finish' },
    { id: 'finish', kind: 'end' },
  ],
}

describe('parseStoredWorkflow', () => {
  it('parses the order follow-up flow', () => {
    const stored = parseStoredWorkflow(ORDER_FOLLOW_UP_FLOW)
    expect(stored.shape).toBe('flow')
    if (stored.shape !== 'flow') throw new Error('unreachable')
    expect(flowNodeById(stored.flow, 'endReassigned').kind).toBe('end')
  })

  it('still parses a shop step definition as shape "shop"', () => {
    const stored = parseStoredWorkflow(SHOP_DEFINITION)
    expect(stored.shape).toBe('shop')
  })

  it('parses the branch fixture', () => {
    expect(parseStoredWorkflow(BRANCH_FLOW).shape).toBe('flow')
  })

  it('parses the duration-wait fixture', () => {
    expect(parseStoredWorkflow(DURATION_FLOW).shape).toBe('flow')
  })

  it('refuses a business-hours duration wait', () => {
    const businessHoursFlow = {
      ...DURATION_FLOW,
      nodes: {
        ...DURATION_FLOW.nodes,
        pause_1m: {
          ...DURATION_FLOW.nodes.pause_1m,
          input: { ...DURATION_FLOW.nodes.pause_1m.input, businessHours: true },
        },
      },
    }
    expect(() => parseStoredWorkflow(businessHoursFlow)).toThrow(NonRetryableError)
  })

  it('refuses a branch exit that names no node', () => {
    const nullOtherwise = {
      ...BRANCH_FLOW,
      nodes: {
        ...BRANCH_FLOW.nodes,
        checkBand: { ...BRANCH_FLOW.nodes.checkBand, otherwise: null },
      },
    }
    expect(() => parseStoredWorkflow(nullOtherwise)).toThrow(NonRetryableError)
  })

  it('refuses an unwired exit at parse time', () => {
    const dangling = {
      ...ORDER_FOLLOW_UP_FLOW,
      nodes: {
        ...ORDER_FOLLOW_UP_FLOW.nodes,
        tellOwner: { ...ORDER_FOLLOW_UP_FLOW.nodes.tellOwner, next: 'nowhere' },
      },
    }
    expect(() => parseStoredWorkflow(dangling)).toThrow(NonRetryableError)
  })

  it("flowNodeExits returns assign_lead's two exits", () => {
    const stored = parseStoredWorkflow(ORDER_FOLLOW_UP_FLOW)
    if (stored.shape !== 'flow') throw new Error('unreachable')
    expect(flowNodeExits(flowNodeById(stored.flow, 'reassign1'))).toEqual([
      { exit: 'next', next: 'tellOwner' },
      { exit: 'no_candidate', next: 'tellManager' },
    ])
  })

  // advance_stage has 'next' and 'blocked' exits; a node wiring 'blocked' must
  // get both exits back, not just 'next'.
  it("flowNodeExits returns advance_stage's blocked exit", () => {
    const node: FlowActionNode = {
      id: 'adv1',
      kind: 'action',
      action: 'advance_stage',
      input: { stageCode: 'qualified' },
      next: 'endA',
      exits: { blocked: 'endB' },
    }
    expect(flowNodeExits(node)).toEqual([
      { exit: 'next', next: 'endA' },
      { exit: 'blocked', next: 'endB' },
    ])
  })
})
