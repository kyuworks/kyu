// Shop-authored flows in the CRM node shape (workflow/crmFlowDefinition.ts). Test fixtures only.
export const ORDER_FOLLOW_UP_FLOW = {
  schemaVersion: 1,
  trigger: { key: 'order_placed' },
  conditions: null,
  entryNodeId: 'call1',
  nodes: {
    call1: {
      id: 'call1',
      kind: 'action',
      action: 'create_task',
      input: {
        title: 'Call the customer about their order',
        priority: 'normal',
        dueInMinutes: 30,
        businessHours: true,
        assignee: 'order_owner',
      },
      next: 'waitCall',
    },
    waitCall: {
      id: 'waitCall',
      kind: 'wait',
      wait: 'for_completion',
      input: { taskStepNodeId: 'call1', timeoutMinutes: 120, businessHours: true },
      exits: { completed: 'endCalled', timed_out: 'release1' },
    },
    release1: {
      id: 'release1',
      kind: 'action',
      action: 'unassign_lead',
      input: {},
      next: 'reassign1',
    },
    reassign1: {
      id: 'reassign1',
      kind: 'action',
      action: 'assign_lead',
      input: { strategy: 'round_robin' },
      next: 'tellOwner',
      exits: { no_candidate: 'tellManager' },
    },
    tellOwner: {
      id: 'tellOwner',
      kind: 'action',
      action: 'notify',
      input: {
        recipients: { owner: true },
        title: 'An order follow-up is now yours',
        body: 'Call the customer about their order.',
      },
      next: 'endReassigned',
    },
    tellManager: {
      id: 'tellManager',
      kind: 'action',
      action: 'notify',
      input: {
        recipients: { manager: true },
        title: 'No one is free to follow up an order',
        body: 'Assign the follow-up by hand.',
      },
      next: 'endUnassigned',
    },
    endCalled: { id: 'endCalled', kind: 'end', outcome: 'called' },
    endReassigned: { id: 'endReassigned', kind: 'end', outcome: 'reassigned' },
    endUnassigned: { id: 'endUnassigned', kind: 'end', outcome: 'unassigned' },
  },
}

export const BRANCH_FLOW = {
  schemaVersion: 1,
  trigger: { key: 'order_placed' },
  conditions: null,
  entryNodeId: 'checkBand',
  nodes: {
    checkBand: {
      id: 'checkBand',
      kind: 'branch',
      exits: [{ label: 'warm', condition: { field: 'scoreBand', op: 'eq', value: 'warm' }, next: 'thankYou' }],
      otherwise: 'endSkipped',
    },
    thankYou: { id: 'thankYou', kind: 'action', action: 'notify', input: {}, next: 'endThanked' },
    endThanked: { id: 'endThanked', kind: 'end', outcome: 'thanked' },
    endSkipped: { id: 'endSkipped', kind: 'end', outcome: 'skipped' },
  },
}

export const DURATION_FLOW = {
  schemaVersion: 1,
  trigger: { key: 'order_placed', config: {} },
  conditions: null,
  entryNodeId: 'pause_1m',
  nodes: {
    pause_1m: {
      id: 'pause_1m',
      kind: 'wait',
      wait: 'duration',
      input: { minutes: 1, businessHours: false },
      exits: { done: 'end_paused' },
    },
    end_paused: { id: 'end_paused', kind: 'end', outcome: 'paused' },
  },
}
