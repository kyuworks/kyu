# User-defined workflows run through one interpreter, not one Hatchet workflow per definition

**Status:** accepted on 2026-09-21
**Date:** 2026-09-20
**Parent:** [#1](https://github.com/kyuworks/kyu/issues/1)
**This is not** a decision about worker pools or engine-side rate limits for third-party API calls; that is its own record.

A consuming project runs every user-defined workflow definition through one durable handler that reads the definition as data and walks its steps. It does not compile a definition into a Hatchet workflow of its own.

---

## Context

A company product has a visual workflow builder. A person picks a trigger, drags in steps such as delays, waits and branches, and picks actions such as notifying a user or creating a task. Definitions are data: people create and edit them at runtime, and each one belongs to a business tenant. Three words below are exact: a **definition** is what a person composes, a **version** is a pinned revision, a **step** is a node in a version.

Hatchet workflows are code. `durable()` in `packages/sdk/src/consume/durable.ts` builds one durable task per call, binds it to exactly one message name (`onEvents: [definition.name]`), and the worker registers the set it was given at startup. Nothing in the engine reads a task out of a database.

The SDK already gives a durable handler what a run needs: `sleepFor`, `waitFor` a correlated message with a timeout, and `onceById` for a replay-safe side effect. `examples/shop/src/handlers/watchShipping.ts` runs all three against the local engine today. The design document (§ 13, Phase 4) says each run becomes one durable handler reading the definition. This record fixes how.

---

## Options considered

**A. Compile each definition into its own Hatchet workflow.** Reuses the engine's step graph and dashboard. But the engine cannot learn a workflow from a row: every edit needs a re-registration, per business tenant. Lost.

**B. Run a second workflow engine beside Kyu.** Buys a product built for definitions as data. Adds a system to run and a second place to be idempotent, against [20260916-hatchet-is-the-engine](20260916-hatchet-is-the-engine.md). Lost.

**C. One durable interpreter over definitions stored as data.** Adds an interpreter to own and test. Definitions change with no deploy and no registration, and every step is a primitive the SDK already ships. Won.

---

## Decision

1. **The definition is data in the consuming project's database.** Kyu never reads it.
2. **One trigger message, `crm.workflow.triggered`, starts a run.** A `durable()` call binds one message name, so one interpreter cannot listen to several triggers. The project publishes this message from its own seams, such as a pipeline stage change or a cron tick, and one durable handler, `run-workflow`, subscribes to it. The envelope carries ids only: the tenant id, the workflow run id, the definition id and the version id.
3. **The project mints the workflow run id**: a uuid v7 at trigger time, or the triggering envelope's id. It is the `correlationId` of every command the run publishes, which `packages/schemas/src/envelope.ts` requires to be a uuid v7, and it keys the run's ledger rows, whose `kyu_processed.envelope_id` is a `uuid`. It never changes across replays, because the handler body re-runs from the top. Hatchet's own `ctx.runId` is not it.
4. **The run pins its version at the start.** The version id rides the trigger envelope and is written to the run's ledger row. The interpreter loads that version every time, so an edit made while a run is parked never changes what the run walks.
5. **Each step maps to a primitive that exists.** A delay is `sleepFor`. A wait is `waitFor` with a timeout. A branch is a condition the interpreter evaluates in code, over the ids it holds and the project's own data. An action is `publish()` of a command such as `crm.user.notify`, consumed by an ordinary handler.
6. **Every step effect goes through `onceById`**, keyed on the run id and the step id, so a replay never repeats an action.
7. **A branch decision is checkpointed.** Only `sleepFor`, `waitFor` and `now()` replay from the durable log, so a branch read over live data could take a different exit than the run already took. The interpreter reads that step's recorded exit from the ledger first, written in the same `onceById` transaction as the decision, and reuses it.
8. **Step content stays in the version.** An action step carries the authored text, such as a notification title and body. Its command carries ids only: the envelope's tenant id, the run id, the version id and the step id. The handler reads that step's input from the pinned version, renders it, then sends, and takes names and contact details from tenant data.
9. **A proof example must exercise this record.** Under `examples/`: trigger on a lead entering a stage, wait a duration, branch on a completed task, notify the owner, with one forced restart across the branch. If the example contradicts a rule here, this record reopens.

---

## Consequences

**Positive**

- Workflow semantics live in one place, covered by the must-hold rows this repository already runs: idempotent redelivery, nothing delivered from a rolled-back publish, the tenant id unchanged at the handler, per-key ordering.
- A new step type ships as interpreter code, not as a registration per tenant.
- Actions are ordinary commands, so they take ordinary concurrency keys, retries and rate limits.

**Negative**

- The interpreter is one code path for every tenant's workflows. A bug in it reaches all of them.
- One interpreter serves every business tenant, so a busy tenant can crowd out the quiet ones. The mitigation now exists: `concurrency: { key: TENANT_CONCURRENCY_KEY, maxRuns: 1, strategy: 'round-robin' }` on the interpreter's subscription (archived issue 104).
- A run replays. Parked in `sleepFor` or `waitFor`, it is evicted when its worker stops and continues on the next worker; a body that reaches a wait while its worker is stopping fails that attempt with `WorkerStoppingError` and retries, because `durable()` defaults `retries` to 3 (`packages/sdk/src/consume/durable.ts`). That is why every step effect must go through `onceById`.
- Branch conditions are code, so a new kind of condition is a deploy, not a definition edit.
- The SDK lacks six things the interpreter needs. Each is its own issue:
  - cron and scheduled publishing — archived issue 98
  - cancelling a run — archived issue 99
  - a progress view rolled up by `correlationId` — archived issue 100
  - fan-out child steps — archived issue 101
  - a wait over several fields, re-checked on any event for the subject — archived issue 102
  - delays that outlast the execution timeout, such as 30 days against the 24-hour default in `durable()` — archived issue 113, answered in the addendum below

---

## Do not

- Register a Hatchet workflow per definition, per version or per business tenant.
- Put a step's authored text, or a person's name or contact details, in an envelope.
- Load a version other than the one the run pinned.
- Re-evaluate a recorded branch on replay.
- Add a second workflow engine, or let Kyu read a workflow definition.
- Run a step's side effect outside `onceById`.

---

## Reopen when

- Hatchet can build a workflow from data at runtime, with no worker restart.
- A definition needs a step the interpreter cannot express without code written for that one definition.

---

## Addendum — 22 September 2026: how a long delay waits (#113)

A delay step under 60 seconds is `sleepFor`, as decision 5 says: the run parks and the engine holds it.

A delay step of 60 seconds or more is a hand-off. In one transaction, under the step's own `onceById` guard, the interpreter writes the step's ledger row and publishes the trigger message again with `publishAt` set to the wake time, the same run id, the same tenant id, and the step to continue at. The run then ends and holds nothing. At the wake time the relay ships that row and a new run loads the version this run pinned and walks on. A delay of any length is legal, including 30 days.

The threshold exists because a run's total sleep must stay under its execution timeout, which `durable()` sets to 24 hours and `run-workflow` to 1 hour. A definition has at most 20 steps, each below the 60-second hand-off boundary, so the worst run sleeps in process for just under 20 minutes.

The continuation keeps the trigger's message name, so it queues in the same concurrency group (`input.data.orderId`, `maxRuns: 1`): two runs of one order still never run at once. Its place in that order is its wake time, not its publish time.

A run waiting for its continuation is an outbox row with a future `publish_at`. `runs.forEnvelope` reports the run that handed off as `completed`, and the run's `finished_at` is still empty.

Not solved here: cancelling a run, or disabling a definition, between the two runs. A scheduled outbox row cannot be recalled today. That is archived issue 99.

---

## Addendum — 24 September 2026: cancelling a hand-off (#180, #185)

Since archived issue 180 (archived PR 184) and archived issue 185 (archived PR 189), a cancel can recall a scheduled outbox row; the addendum above was written before that. Given the caller's own transaction, `kyu.runs.cancelForCorrelation(runId, { outbox: tx })` cancels the engine's runs under the run id and then every outbox row under it that the relay has not claimed, whether its `publish_at` is still ahead or has already passed. The hand-off continuation carries the run id as its correlation id, so it gets `cancelled_at` and the relay never ships it. Two kinds of row can still reach the engine: one the relay has already claimed, and one whose push the engine took but the relay recorded as failed. The README's paragraph that begins "Given the caller's own transaction" says when, and that a later cancel for the same id stops the run either one starts.

Disabling a definition between the two runs is still not solved.
