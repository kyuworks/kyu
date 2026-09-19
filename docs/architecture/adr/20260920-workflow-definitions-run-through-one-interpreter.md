# User-defined workflows run through one interpreter, not one Hatchet workflow per definition

**Status:** proposed
**Date:** 2026-09-20
**Parent:** none. An issue opens when this record is accepted.
**This is not** a decision about worker pools or engine-side rate limits for third-party API calls; that is its own record.

A consuming project runs every user-defined workflow definition through one durable handler that reads the definition as data and walks its steps. It does not compile a definition into a Hatchet workflow of its own.

---

## Context

A company product has a visual workflow builder. A person picks a trigger, drags in steps such as delays, waits and branches, and picks actions such as sending an SMS, sending an email or allocating a lead. Definitions are data: people create and edit them at runtime, and each one belongs to a business tenant.

Hatchet workflows are code. `durable()` in `packages/sdk/src/consume/durable.ts` builds one durable task per call, and the worker registers the set it was given at startup. Nothing in the engine reads a task out of a database.

The SDK already gives a durable handler what a run needs: `sleepFor`, `waitFor` a correlated message with a timeout, and `onceById` for a replay-safe side effect. `examples/shop/src/handlers/watchShipping.ts` runs all three against the local engine today. The design document (§ 13, Phase 4) says each run becomes one durable handler interpreting the definition. This record fixes how.

---

## Options considered

**A. Compile each definition into its own Hatchet workflow.** Reuses the engine's step graph and dashboard. Every edit needs a re-registration, versions pile up, and registration becomes per business tenant. The engine cannot learn a workflow from a row. Lost.

**B. Run a second workflow engine beside Kyu.** Buys a product built for definitions as data. Adds a system to run and a second place to be idempotent, against [20260916-hatchet-is-the-engine](20260916-hatchet-is-the-engine.md). Lost.

**C. One durable interpreter over definitions stored as data.** Adds an interpreter to own and test. Definitions change with no deploy and no registration, and every step is a primitive the SDK already ships. Won.

---

## Decision

1. **The definition is data in the consuming project's database.** Kyu never reads it.
2. **One durable handler per project, `run-workflow`, subscribes to the trigger messages.** It loads the definition by id from the triggering envelope's `data`, then walks the steps.
3. **Each step maps to a primitive that exists.** A delay is `sleepFor`. A wait is `waitFor` with a timeout. A branch is a condition in the interpreter's code over the ids it holds. An action is `publish()` of a command such as `comms.sms.send`, which an ordinary command handler consumes.
4. **Every step is idempotent through `onceById`**, keyed on the workflow run and the step, so a replay never repeats an action.
5. **Envelopes carry the definition id, the run id, the tenant id and the subject ids only.** The action handler reads names, phone numbers and content from tenant data.
6. **The run's `correlationId` is the workflow run id**, so every message and run in that workflow rolls up together.
7. **A proof example validates this record before it is accepted.** A post-purchase follow-up under `examples/`: trigger on shipped, wait a day, send an email, then send an SMS if no review arrives in three days. It is not built yet.

---

## Consequences

**Positive**

- Workflow semantics live in one place, covered by the must-hold rows this repository already runs: redelivery is idempotent, a rolled-back publish is never delivered, the tenant id reaches the handler unchanged, per-key ordering holds.
- A new step type ships as interpreter code, not as a registration per tenant.
- Actions are ordinary commands, so they take ordinary concurrency keys, retries and rate limits.

**Negative**

- The interpreter is one code path for every tenant's workflows. A bug in it reaches all of them.
- Runs park for days, so the durable edges [#47](https://github.com/Camba-nz/kyu/issues/47) and [#52](https://github.com/Camba-nz/kyu/issues/52) block this work.
- Branch conditions are code, so a new kind of condition is a deploy, not a definition edit.
- The SDK lacks four things the interpreter needs: scheduled triggers on Hatchet cron, cancelling a run, a per-run progress view rolled up by `correlationId`, and fan-out child steps. Each becomes its own issue when the example reaches it.

---

## Do not

- Register a Hatchet workflow per definition, per version or per business tenant.
- Put step content such as names, phone numbers or message bodies in an envelope.
- Add a second workflow engine, or let Kyu read a workflow definition.
- Run a step's side effect outside `onceById`.

---

## Reopen when

- Hatchet can build a workflow from data at runtime, with no worker restart.
- A definition needs a step the interpreter cannot express without code written for that one definition.
