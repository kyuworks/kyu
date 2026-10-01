import { describe, expect, it } from 'vitest'
import { evaluateFlowCondition } from './crmFlowConditions.js'
import type { FlowConditionExpression, ShopLeadProjection } from './crmFlowConditions.js'

const BASE_PROJECTION: ShopLeadProjection = {
  channel: 'web',
  source: 'organic',
  stageCode: 'new',
  scoreBand: 'warm',
  score: 60,
  orgUnitId: null,
  assigned: false,
  isTerminal: false,
  hasMobile: true,
  hasEmail: true,
  isBusinessHours: true,
  conversationState: 'none',
}

const warmProjection = (over: Partial<ShopLeadProjection> = {}): ShopLeadProjection => ({ ...BASE_PROJECTION, ...over })

describe('evaluateFlowCondition', () => {
  it('eq matches a warm projection and not a cold one', () => {
    const condition: FlowConditionExpression = { field: 'scoreBand', op: 'eq', value: 'warm' }
    expect(evaluateFlowCondition(condition, warmProjection({ scoreBand: 'warm' }))).toBe(true)
    expect(evaluateFlowCondition(condition, warmProjection({ scoreBand: 'cold' }))).toBe(false)
  })

  it('and requires every branch true', () => {
    const condition: FlowConditionExpression = {
      and: [
        { field: 'scoreBand', op: 'eq', value: 'warm' },
        { field: 'hasEmail', op: 'is_true' },
      ],
    }
    expect(evaluateFlowCondition(condition, warmProjection({ scoreBand: 'warm', hasEmail: true }))).toBe(true)
    expect(evaluateFlowCondition(condition, warmProjection({ scoreBand: 'warm', hasEmail: false }))).toBe(false)
  })

  it('or requires at least one branch true', () => {
    const condition: FlowConditionExpression = {
      or: [
        { field: 'scoreBand', op: 'eq', value: 'hot' },
        { field: 'scoreBand', op: 'eq', value: 'warm' },
      ],
    }
    expect(evaluateFlowCondition(condition, warmProjection({ scoreBand: 'warm' }))).toBe(true)
    expect(evaluateFlowCondition(condition, warmProjection({ scoreBand: 'cold' }))).toBe(false)
  })

  it('in matches a value in the list', () => {
    const condition: FlowConditionExpression = { field: 'scoreBand', op: 'in', value: ['hot', 'warm'] }
    expect(evaluateFlowCondition(condition, warmProjection({ scoreBand: 'warm' }))).toBe(true)
    expect(evaluateFlowCondition(condition, warmProjection({ scoreBand: 'cold' }))).toBe(false)
  })

  it('gt compares a number field', () => {
    const condition: FlowConditionExpression = { field: 'score', op: 'gt', value: 50 }
    expect(evaluateFlowCondition(condition, warmProjection({ score: 60 }))).toBe(true)
    expect(evaluateFlowCondition(condition, warmProjection({ score: 40 }))).toBe(false)
  })
})
