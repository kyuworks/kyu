# A tenant pause holds messages in the outbox, not on an engine rate limit

**Status:** accepted on 2026-09-24
**Date:** 2026-09-24
**Parent:** [#181](https://github.com/Camba-nz/kyu/issues/181)
**This is not** a decision about tenant-scoped cancel ([#182](https://github.com/Camba-nz/kyu/issues/182)) or product-unit rate limits ([#183](https://github.com/Camba-nz/kyu/issues/183)).

`kyu.tenants.pause(db, tenantId)` holds a business tenant's new outbox rows unclaimed; the relay is the only reader that skips them. It does not call the engine.

---

## Context

Issue #181 asked for a tenant pause built on the engine's own rate limits, keyed by the business tenant id every envelope already carries as metadata (`additional_metadata.tenantId`, CEL `additional_metadata.tenantId`; the relay pushes the whole envelope, so `input.tenantId` also works, `packages/sdk/src/consume/concurrency.ts:11`).

Three scripts probed the local engine directly (hatchet-lite v0.107.0, SDK 1.32.0), each upserting a rate limit and publishing through it; all engine state was removed afterwards (rate-limit keys deleted, runs cancelled by id, workflows deleted), so the numbers below are stated inline rather than pointed at a script:

1. **A dynamic limit is overwritten by every new run.** A task declared `rateLimits: [{ dynamicKey: "'plan181…:' + additional_metadata.tenantId", limit: 1000, ... }]`. `hatchet.ratelimits.upsert({ key: <tenant A key>, limit: 0 })` set the stored row to `0/0`; publishing A's next event reset it to `limitValue 1000` at once, and A's runs completed while "paused" (probe1: `limits after new A runs created: …9fa1=0/1000`, A2/A3 `completed`). This re-upsert is engine-side behavior on hatchet-lite v0.107.0, observed at the API boundary, not read from the engine's own source; the client-side half of the path — the SDK sending the task's declared `limitValuesExpr` on every task creation, cited below — is read from source.
2. **A lookup limit (`limit: '-1'`, no per-run upsert) holds a tenant at 0, but a tenant with no row is held for ever.** probe3: after `upsert(A, 0)` and a 5s wait, A's new runs stayed `queued (never started)`; B's ran; resuming (`upsert(A, 1000)`) ran A2, A3 in order within 0.5s. Tenant C, which never had a row, stayed `queued` for the whole probe — every business tenant needs a row provisioned before its first message, and the only write is an upsert with no create-if-absent, so provisioning from the relay races a pause.
3. **A held run dead-letters at `scheduleTimeout`.** probe3: a subscription with `scheduleTimeout: '15s'` for paused tenant A read `failed (never started)` by the 25s sample. `scheduleTimeout` is per task, not per key (`packages/sdk/src/consume/taskOptions.ts:34-38`), so the SDK cannot raise it for one paused tenant only, and the engine's own default (5 minutes) fails every run held longer than that. The README already states the same fact for rate-limit holds.
4. **A pause is not immediate on the engine.** probe2: runs published within milliseconds of `upsert(A, 0)` still ran; the engine's rate-limit cache took up to roughly 5s to catch up.
5. **An in-flight durable run is not blocked by any of these mechanisms**, which is expected — a rate limit only ever gates a *new* run — but it means none of options A–C below can be the whole answer even where they hold a tenant. probe3's durable `sleepFor('20s')` spanned the pause window and completed (`after-sleep` at 22.4s while A's limit was 0).

Vendored SDK citations (`node_modules/.pnpm/@hatchet-dev+typescript-sdk@1.32.0…/node_modules/@hatchet-dev/typescript-sdk/`): `ratelimits.upsert` → `v1/client/features/ratelimits.js:32-37` → `admin.putRateLimit` `v1/client/admin.js:273-282`; task `rateLimits` shape `v1/task.d.ts:196-203`; `mapRateLimitPb` `v1/client/worker/workflow-proto.js:342-402` (a number limit becomes `limitValuesExpr` at 377-379; a dynamic key with no limit throws at 388-390; a missing limit becomes `'-1'` at 391-393); proto `CreateTaskRateLimit` `protoc/v1/workflows.d.ts:255-268`; `rateLimitDelete(tenant, { key })` `clients/rest/generated/Api.d.ts:1259-1262`; `validateCelExpression` is a no-op `workflow-proto.js:471-475`.

`kyu_outbox.tenant_id` already exists (`packages/sdk/migrations/20260916233209_create_outbox.sql:10`), and `claimPendingRows` (`packages/sdk/src/outbox/outboxRepository.ts`) already skips rows on a boolean condition (`cancelled_at`, issue #180) inside the same claim query.

---

## Options considered

**A. Engine dynamic rate limit, keyed by tenant.** The obvious reading of the issue. Every new run re-upserts the declared limit, so the "pause" is undone by the next publish for that tenant (finding 1). Lost.

**B. Engine lookup rate limit, keyed by tenant.** Holds a tenant genuinely at 0. But an unprovisioned tenant is held for ever, provisioning races an operator's pause, and a run held past `scheduleTimeout` dead-letters instead of waiting (finding 2, 3). Lost.

**C. Concurrency `maxRuns` expression, keyed by tenant.** Same failure shape as option A: "a group's effective limit is the value from its most recently created task" (`v1/task.d.ts:23-26`), so a new run for the tenant overwrites the pause the same way a dynamic rate limit does. Lost.

**D. Handler-side check that throws to re-queue.** The message reaches the engine and starts a run; the handler reads a paused flag and throws to force a retry. Burns retries, then dead-letters, and does not stop a run from starting at all. Lost.

**E. Hatchet event filters that drop the event.** Filters can discard an event before it becomes a run, but a drop is not a hold: the message is gone, not waiting. Lost.

**F. Hold the tenant's rows in the outbox; never call the engine.** The pause lives in the project's own database, the same one `publish()` already writes to. The relay's claim query is the only reader that needs to change, exactly the shape `cancelled_at` (#180) already established. A held message is never in the engine, so `scheduleTimeout` — the ceiling every rate-limit-based option collided with — cannot apply to it by construction. Won.

---

## Decision

1. **A pause is a row, not an engine call.** `kyu.tenants.pause(db, tenantId)` inserts into `kyu_paused_tenant` (`packages/sdk/migrations/20260924124242_paused_tenant.sql`). `resume` deletes it. `isPaused` reads it. `db` is the caller's own pool or transaction — the pause takes effect (or not) exactly with that transaction, the same as `publish()`.
2. **The relay's claim is the only reader.** `claimPendingRows` adds `AND NOT EXISTS (SELECT 1 FROM kyu_paused_tenant p WHERE p.tenant_id = kyu_outbox.tenant_id)` inside its existing subquery. A null `tenant_id` never matches `p.tenant_id`, so a tenant-less message is never held.
3. **Runs already in the engine are never touched.** Nothing here calls `hatchet.runs.cancel`, a rate limit, or a concurrency key. A running, parked (`sleepFor`/`waitFor`), or queued run for the paused tenant is left alone by this feature. If that run itself publishes a new message for the same tenant while paused — a command it then `waitFor`s a reply to — the reply is held like any other message for that tenant, and the wait wears down its own timeout, not an engine cancel (README, "Tenant pause").
4. **No engine call on pause or resume.** The whole feature is one INSERT, one DELETE and one SELECT against the project's own database.
5. **On resume, the backlog ships at relay speed and then queues at the engine like any other burst.** An operator sizing `scheduleTimeout` for a subscription a paused tenant uses must size it for that burst, not just steady-state load.

---

## Consequences

**Positive**

- No dead-letter risk: a held message is never in the engine's queue, so `scheduleTimeout` cannot fail it, however long the pause lasts.
- Immediate: the pause takes effect on commit, not on an engine-side cache that can lag (finding 4).
- Transactional: pause and resume follow the caller's own transaction boundary, the same guarantee `publish()` gives.

**Negative**

- A new migration (`kyu_paused_tenant`) that every consumer must apply before the relay that reads it deploys.
- The pause covers only messages this project's own relay ships. A message already claimed by the relay when the pause commits still ships (documented, not tested against — see the SDK integration test's known-and-documented note). A message that reached the engine before the pause is untouched by design (decision 3), not a gap.
- Every claim query now scans past a paused tenant's backlog. Fine at the thousands-of-rows scale this repository runs at; not measured at 50,000 pending rows for one paused tenant.

---

## Do not

- Call `hatchet.ratelimits.upsert`, a concurrency `maxRuns` expression, or any other engine primitive to implement a pause.
- Cancel, evict, or otherwise touch a run already in the engine when a tenant is paused.
- Let `isPaused`, `pause` or `resume` read or write anything outside `kyu_paused_tenant`.

---

## Reopen when

- The engine gains a per-key pause primitive, or a rate-limit write with create-if-absent semantics that does not get overwritten by the next run.
