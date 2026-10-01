# A CRM flow definition on Kyu

A CRM flow definition in the consuming project's node shape runs to an end node on Kyu through the shop's one durable interpreter. Two more definitions in the same shape exercise a `branch` node and a `duration` wait, the two kinds the order follow-up flow does not use.

## What ran

The node shape was read from the consuming project's flow engine code on 2026-09-22, read only. The three fixtures are shop-authored in that shape, not copies: `ORDER_FOLLOW_UP_FLOW`, `BRANCH_FLOW` and `DURATION_FLOW` in `examples/shop/src/__tests__/crmFlowFixtures.ts`. They are test fixtures, not production code, and are stored as-is in `shop_workflow_version.steps`.

The path the shop walked through the order follow-up flow (no task subsystem exists, so the completion leg can never fire and the timeout leg always wins):

`call1` (create_task) → `waitCall` (for_completion, exit `timed_out`) → `release1` (unassign_lead) → `reassign1` (assign_lead, exit `next`) → `tellOwner` (notify) → `endReassigned` (end, outcome `reassigned`)

Never reached: `endCalled`, `tellManager`, `endUnassigned`.

Test: `examples/shop/src/__tests__/crmFlow.integration.test.ts`, `run-workflow: a CRM flow definition > walks the order follow-up flow and finishes on a new worker after a restart`.

**PR B adds two more definitions in the same shape:**

- `BRANCH_FLOW`: a `branch` node (`checkBand`) with one labelled exit (`warm`, condition `scoreBand eq warm` → `thankYou`) and `otherwise: 'endSkipped'`, an action node (`thankYou`, `notify`), and two end nodes (`endThanked` outcome `thanked`, `endSkipped` outcome `skipped`). The branch condition is evaluated against `shop_lead_projection`, a stub the shop owns (`examples/shop/migrations/0007_shop.sql`), seeded `scoreBand: 'warm'`. Path walked: `checkBand` (exit `warm`, next `thankYou`) → `thankYou` (notify) → `endThanked` (outcome `thanked`).
- `DURATION_FLOW`: a `duration` wait (`pause_1m`, `minutes: 1, businessHours: false`) and one end (`end_paused`, outcome `paused`). Path walked: `pause_1m` (exit `done`, next `end_paused`) → `end_paused` (outcome `paused`).

Tests: `examples/shop/src/__tests__/crmFlowBranchAndWait.integration.test.ts`, `run-workflow: a CRM flow branch node > decides the branch once and reuses the recorded exit when the trigger is redelivered` and `run-workflow: a CRM flow duration wait > hands the one-minute wait off and finishes on a worker started after the first one stopped`.

The branch test forces a replay by redelivering the trigger with the same run id after changing the projection to `cold`: the ledger does not move, proving the branch decided once and reused its recorded exit (ADR decision 7) rather than re-deciding against the changed projection. The duration test forces a worker restart across the wait's hand-off: the CRM flow engine's shortest duration wait is one minute, which is exactly the shop's hand-off threshold (`DELAY_HANDOFF_SECONDS`, `runWorkflow.ts:31`), so the run always ends holding nothing and a scheduled continuation finishes it on a second worker, a real minute later. Nothing shortens the fixture or moves the clock.

## What the order follow-up flow does not exercise

The issue asked for a flow with an action, a duration wait and a branch with two end nodes. None of the flows the consuming project ships as templates has a `branch` node or a `wait: 'duration'` node. Both kinds appear only in that project's own tests and generators.

This changes acceptance criterion 3 of issue #157 (the branch decision checkpoint) and part of criterion 2 (the duration wait). The issue's own "Correction after planning" section splits the work into two pull requests: PR A used the closest shipped flow shape (an entry action, four action nodes, one `for_completion` wait, three ends with outcomes, one named non-`next` exit). PR B, above, closes the gap with two more fixtures in the same shape.

## Node kinds

| node kind | status | Kyu file | note |
|---|---|---|---|
| `action` | mapped | `examples/shop/src/workflow/crmFlowDefinition.ts` (`flowActionNodeSchema`), `examples/shop/src/handlers/runWorkflow.ts` (`walkFlowNode`, `'action'` case) | Reuses the shop's `shop.staff.notify` command; the note recorded is `"<actionKey> <nodeId>"`, not a real executor. Seven action keys known: `create_task`, `unassign_lead`, `assign_lead`, `notify`, `advance_stage`, `send_internal_email`, `export_dashboard`. |
| `branch` | changed | `examples/shop/src/workflow/crmFlowDefinition.ts` (`flowBranchExit`) and `examples/shop/src/handlers/runWorkflow.ts` (case `'branch'`) | Decided once, checkpointed in `shop_workflow_step_log.exit_step_id`, reused on redelivery (ADR decision 7). A branch exit that names no node (a labelled exit's `next: null`, or `otherwise: null`) is refused at parse time (`crmFlowSchema`'s superRefine), where the CRM flow engine would complete the run on that exit instead; `exits` also requires at least one entry (`.min(1)`) where the CRM flow engine allows a branch with none. No shipped flow uses it; proved with a shop-authored fixture. |
| the condition language / lead projection | changed | `examples/shop/src/workflow/crmFlowConditions.ts` and `examples/shop/migrations/0007_shop.sql` | The evaluator is the CRM flow engine's, ported whole; the projection is a stub the shop owns, keyed by the run's order id, not a server-built lead snapshot. Authoring-time field/operator validation is not ported. The CRM flow engine's evaluator casts its right-hand operand to a number without checking its type; the port requires both operands to be finite numbers (`isFiniteNumber`), so a numeric comparison against a string value, such as `score gt "50"` with `score: 60`, reads false here and true there. It is reachable only because the authoring-time superRefine that would reject that value is not ported. |
| `end` + `outcome` | changed | `examples/shop/migrations/0006_shop.sql`, `examples/shop/src/workflow/store.ts` (`finishRun`) | New `shop_workflow_run.outcome text` column, null for the shop's own step shape. |
| named exits (non-`next`) | mapped | `crmFlowDefinition.ts` (`ACTION_EXITS`, `flowNodeExits`) | `reassign1`'s `no_candidate` is validated and wired (to `tellManager`) but never chosen: the walker only ever takes `next`. Only `tellOwner`'s `next` is reachable in the walked path. |
| action input validation | missing | none | The branch fixture's `notify` node (`thankYou`) carries `input: {}`, which the CRM flow engine's own validator would reject (its `notify` entry requires a body). The shop parses the node and never reads the input: the executors are out of scope (ADR decision 8). |

## Wait kinds

| wait kind | status | Kyu file | note |
|---|---|---|---|
| `for_completion` | changed, timeout leg only | `runWorkflow.ts` (`walkFlowNode`, `'wait'` case) | The shop has no task subsystem, so the `completed` exit can never fire; only `timed_out` is reachable. `businessHours` is parsed but ignored (see below). Reuses the existing `DELAY_HANDOFF_SECONDS` hand-off/`sleepFor` split. |
| `duration` | changed | `examples/shop/src/handlers/runWorkflow.ts:31` (`DELAY_HANDOFF_SECONDS`), `crmFlowDefinition.ts` (`flowWaitDurationInputSchema`) | The CRM flow engine's shortest duration wait is one minute, which is exactly Kyu's hand-off threshold, so every CRM flow duration wait becomes a scheduled continuation and none parks in `sleepFor`. No shipped flow uses it; proved with a shop-authored fixture. |
| `for_condition` | missing | none | Needs the lead projection and condition language `branch` also needs (now built, see the row above), plus a satisfying-event trigger the shop has no model for. Refused at the trust edge. |
| `sla` | missing | none | Needs a workflow-category trigger, business-hours binding and satisfier keys. No shipped flow's entry node is anything but this or an action, and only an action entry could even start a run on the shop as it stands today. Refused at the trust edge. |
| `businessHours` | changed | `examples/shop/src/workflow/crmFlowDefinition.ts` (`flowWaitDurationInputSchema`) | Refused on a `duration` wait with a `NonRetryableError`, because the shop has no business calendar and treating business hours as clock time would produce a wake time that is simply wrong. Still parsed and ignored on `for_completion`, which PR A's flow sets to `true`: tightening that one too would stop PR A's already-landed flow from running. |

## What Kyu does not have yet

- **Business-hours calendars** — every wait and task due date in the CRM flow engine can bind to business hours; the shop has no calendar concept, so `businessHours` is parsed and ignored everywhere.
- **A task subsystem** — `for_completion`'s `completed` exit depends on a task being marked done; nothing in the shop creates or completes tasks, so that leg is unreachable and only the `timed_out` leg was proven.
- **A satisfying-event trigger for `wait: 'for_condition'`** — `branch`'s condition language and a stub lead projection now exist (`examples/shop/src/workflow/crmFlowConditions.ts`, PR B), but `for_condition` also needs a trigger that re-evaluates the expression as events arrive; the shop has no such model, so this wait kind is still refused.
- **Workflow-category triggers and satisfier keys** — `sla` waits need a workflow trigger taxonomy to know what "contacted" means; the shop has no such trigger taxonomy.
- **Tenant pause in the shop** — the CRM flow engine can pause all flow activity for a tenant. When this page was written, neither the shop nor the SDK had a pause. Since 2026-09-24 the SDK has `kyu.tenants.pause` (issue #181, PR #186), which holds a tenant's new messages in the outbox; the shop's workflow trigger and its hand-off continuation both carry the tenant id (`examples/shop/src/producer/triggerWorkflow.ts:37`, `examples/shop/src/handlers/runWorkflow.ts:126`), so both would wait while the tenant is paused. That is read from the code, not tested with a workflow: the harness scenario `tenant-paused` pauses a tenant during `watch-shipping` (`examples/shop/README.md`). What the shop still lacks against the CRM flow engine: no switch of its own that calls the pause, and a `run-workflow` run already in the engine carries on through its in-run steps instead of waiting at the next one, though a command it publishes, such as `shop.staff.notify`, waits in the outbox.
- **Product-unit rate limits in the shop** — the CRM flow engine's costed actions (`notify`, `export_dashboard`) are rate-limited per product unit; the shop's `notify-staff` still declares no rate limit. Since 2026-09-24 the SDK can express one, `rateLimit: { per: 'tenant', limit, window }` (issue #183, PR #188), but its `limit` is one number fixed on the subscription, not the per-tenant setting the CRM flow engine reads.
- **Cycle and reachability validation at parse time** — the shop's own step shape rejects a cycle and an unreachable step in `workflowDefinitionSchema`'s `superRefine`, via the `walkFromStart` DFS (`examples/shop/src/workflow/definition.ts:55-100`); the CRM flow shape does not port this — `crmFlowSchema`'s `superRefine` (`crmFlowDefinition.ts`) checks node-id/key agreement and that named targets exist, but never walks for a cycle, so a two-action `next` cycle parses fine. The walker's existing hop bound (`Object.keys(flow.nodes).length` in `runWorkflow.ts`) still turns a cycle into a `NonRetryableError` at run time instead of at parse time.

## How to re-run it

```
source examples/shop/.env.local
export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/token.sh)" HATCHET_CLIENT_TLS_STRATEGY=none
export KYU_SHOP_DATABASE_URL=postgresql://hatchet:hatchet@localhost:15432/<lane db>
export KYU_SHOP_NAMESPACE=<namespace>_
pnpm build
pnpm --filter @kyuworks/shop exec vitest run --config vitest.integration.config.ts src/__tests__/crmFlow.integration.test.ts
pnpm --filter @kyuworks/shop exec vitest run --config vitest.integration.config.ts src/__tests__/crmFlowBranchAndWait.integration.test.ts
```

The second command takes over a minute: the duration-wait test waits out a real one-minute CRM flow wait, with no clock manipulation.
