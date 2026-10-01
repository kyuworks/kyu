# Kyu against the consuming project's in-house flow engine

> The shop now lives in [`kyuworks/shop-example`](https://github.com/kyuworks/shop-example). `examples/shop/` paths below are as of kyu commit 4bbff93; in that repository they start at its root.

## What this settles

The consuming project's automation flows are moving onto Kyu. This document answers the same nine failure and
load scenarios for both engines, side by side, so the move can be checked against evidence instead
of taken on trust.

- **Kyu**: the company message bus in this repository. An outbox row inside the caller's own
  transaction, a relay that ships it, and Hatchet-backed handlers (`subscribe`, `durable`) that
  read it.
- **The in-house engine**: a queue table in the consuming project's own Postgres database, drained
  by a poll loop that runs inside its API process.

## Commits, machine, and why the in-house column is code-level

- Kyu: `main` at `99da6f5`.
- Kyu file and line citations: re-checked against `main` at `a886eb9` on 2026-09-25 (issue #200).
  Only the citations were re-checked; no run was repeated and no verdict changed.
- The in-house engine: read from the consuming project's code on 2026-09-22, read only.
- Machine: this repository's own development machine — one Docker host running Kyu's local
  Hatchet stack, nothing else.

The in-house column is a reading of the code, not a run of it. The in-house flow engine needs a
hosted-Postgres local stack of eight-plus containers to start, with SMS and email hooks that need
secrets this repository does not hold. That is eight-plus containers on top of Kyu's own engine,
on one machine that does not have room for both. The flows engine is additionally gated behind two
flags that the read-only clone has no reason to have set.
Every in-house claim below was read from that code on 2026-09-22.

### The Kyu column: a note on what is measured

Issue #144 asked for a harness that runs these nine scenarios against Kyu and records what
happens; the report lists ten, because it runs the two cancels folded into scenario 8 below —
`cancel-parked` and `cancel-between-steps` — as separate scenarios. That harness landed in PR #148,
and its report — `docs/proofs/2026-09-22-shop-failure-harness.md` on `main` (`99da6f5`) — now
supplies every Kyu cell below that needed a measured number. Each of those cells says **measured by the shop failure
harness, `docs/proofs/2026-09-22-shop-failure-harness.md`** and names the scenario, so a reader can
trace the number back to its run. That run was made on the machine the report names: an Apple M5,
10 CPUs, 32 GB RAM, macOS 26.5.1 (build 25F80), arm64, against `hatchet-lite:latest`, with the
Docker Desktop VM capped at 1.9 GB. Where Kyu's behavior is instead proven by a merged integration
test — not the harness, but a test that exercises the real failure through a real worker process
and a real crash — the cell still says **proven by test, not measured** and names the file. One
scenario, `tenant-load` (scenario 6 below), failed at the report's full size in that run. A
second run below, after issue #149 landed `scheduleTimeout` and the worker's durable-slot setting
was retuned, passed at the same size; that scenario's own section says what failed, why, and what
changed.

## How the two systems line up

The scenario names below are Kyu-shaped: the in-house engine has no relay and no outbox, because its queue and
its business data share one Postgres database and one process.

| Concept | Kyu | In-house equivalent |
|---|---|---|
| relay | `packages/sdk/src/relay/relay.ts` (`startRelay`) | a trigger hook that enqueues a job |
| outbox | `kyu_outbox` (`packages/sdk/migrations/20260916233209_create_outbox.sql`), written inside the caller's transaction (`packages/sdk/src/outbox/publish.ts:71-72`) | nothing — the enqueue is outside the caller's transaction |
| worker | `packages/sdk/src/consume/worker.ts` (`createWorker`), a separate process | the co-located poll loop |
| engine | self-hosted Hatchet, a separate service | the same Postgres as the business data |
| parked run | a durable Hatchet wait (`sleepFor`/`waitFor`), or — past 60 seconds — a scheduled outbox row (`publish_at`) and no run at all, see the 48-hour scenario below | a run-table status of `waiting` plus a wake time |
| dead letter | a failed run: alerted on, replayable, nothing swallows it (`AGENTS.md`, "Delivery rules") | a `dead` status in its queue table, reported to an error tracker |

## Scenario tables

### 1. Relay killed mid-batch

What is injected: the relay process dies partway through pushing a batch of outbox rows to the
engine.

| | Kyu | In-house (code-level) |
|---|---|---|
| Behavior | measured by the shop failure harness, `docs/proofs/2026-09-22-shop-failure-harness.md` (scenario `relay-killed-before-mark`): a relay child was SIGKILLed on the exact statement that would mark a row published, between pushing 20 orders (40 envelopes: `shop.order.placed` + `shop.invoice.send`) and marking them; a second relay reclaimed the row once its claim went stale — the reclaim took 30189ms against the scenario's 30000ms stale-claim window, right at the edge, as designed. The engine's own run history shows 6 duplicate engine-side runs for the one envelope the race hit, and every one still produced exactly one effect (no doubled effect, no failed run); 85 handler-log rows for 40 envelopes, no gaps, no doubles. Passed in 40.1s. Proven by test, not measured: a crash between the push and the mark that settles a claimed row releases the claim immediately (the relay's own `finally`), and the next tick republishes it — `packages/sdk/src/relay/relay.integration.test.ts:219-250` ("a claim is released and republished after a crash between push and mark"). Two relays sharing one database each deliver every row exactly once, even running concurrently — `relay.integration.test.ts:170-217` ("two relays sharing one database each deliver every row exactly once"). | the analogue is the process dying between the business commit and the enqueue; there is no outbox row, no retry, and the failure is logged and swallowed, so the trigger is lost. The inverse also exists: the enqueue happens before the caller commits, so a rolled-back transaction can still leave a trigger job, which the 5 s deferral narrows but does not close. |

**Verdict: Kyu.** Kyu's outbox row already exists before the relay ever runs, and a crashed relay
loses a claim, not a message. The in-house enqueue can be lost or can outlive a rollback, by its own
code.

### 2. Worker killed mid-step

What is injected: the process running a handler dies while a step's side effect is in flight.

| | Kyu | In-house (code-level) |
|---|---|---|
| Behavior | measured by the shop failure harness, `docs/proofs/2026-09-22-shop-failure-harness.md` (scenario `worker-killed-mid-step`): a worker was SIGKILLed while `watch-shipping` was still inside its `sleepFor('5s')`, before it had genuinely parked; the redelivered run finished on a second worker (pid 90398), landing on `watch-shipping:timeout` as its terminal row (the scenario's 8s watch timeout is shorter than the order is ever shipped) — exactly one waiting row, exactly one terminal row, no failed runs. Passed in 58.4s; the report does not break out a restart-latency number separate from that total. Proven by test, not measured: stopping a worker while a durable handler's body is still executing (the sleep or wait not yet parked) fails that attempt with a listener-stopped error; `durable()`'s default 3 retries redeliver it to the next worker, and every write goes through `onceById`, so the replay is safe — `examples/shop/src/__tests__/restart.integration.test.ts:327-375` ("survives a stop during execution"). | no loss; the step comes back, roughly 15-16 minutes later (derived: the sweep flips a stuck step back to `pending` at 420 s, but the step enqueue's `ON CONFLICT ... DO NOTHING` is a no-op while the dead worker's job row is still `running`, so the actual restart waits for the reaper's 15-minute window, plus up to 60 s of reaper interval) — and the side effect already sent is sent again for three of the seven actions: four action entries carry `idempotent: false`, but `create_task` guards itself with its own marker keyed on `stepId`, so only three actually double, by the engine's own admission. |

**Verdict: Kyu on both latency and doubling.** The scenario ran in 58.4 s end to end, and the merged
bound is 120 s (`restart.integration.test.ts:358`), against the in-house engine's derived 15 to 16 minutes.
`onceById` is the one place a step's effect is guarded, not a per-action opt-in three of seven
actions skip.

### 3. Worker killed while parked

What is injected: the worker holding a durable wait (a delay or a wait-for-message) is killed while
the run is genuinely parked, not mid-execution.

| | Kyu | In-house (code-level) |
|---|---|---|
| Behavior | measured by the shop failure harness, `docs/proofs/2026-09-22-shop-failure-harness.md` (scenario `worker-killed-while-parked`): a worker was SIGKILLed only once `watch-shipping` was genuinely parked in `ctx.waitFor` (past the sleep); the order was then shipped while no worker was running, and a second worker picked the durable run back up — the completed row's pid matched the second worker (90471), the recorded carrier (`ups`) matched what was shipped, and no run failed. Passed in 49.9s. Proven by test, not measured: a run parked in a durable wait, with its worker stopped by `SIGTERM` and no worker running while the wake condition arrives, completes once a new worker starts; the completed row's pid is the new worker's, not the old one's — `restart.integration.test.ts:257-325` ("a parked run completes in a new worker process after a restart (headline)"). | nothing is lost, because nothing is held in a process; the park is a row, and the next 60 s sweep on any machine wakes it. |

**Verdict: level.** Both systems keep the parked state outside the dead process — Hatchet's own
durable log for Kyu, a row plus a sweep for the in-house engine — so a worker restart loses nothing either way.

### 4. Database connection dropped under the shipper

What is injected: the relay's (Kyu) or the queue's (in-house) own database connection is severed while
work is in flight.

| | Kyu | In-house (code-level) |
|---|---|---|
| Behavior | measured by the shop failure harness, `docs/proofs/2026-09-22-shop-failure-harness.md` (scenario `relay-db-connection-dropped`): `pg_terminate_backend` was run against the relay's own Postgres connection while it was mid-tick, for 20 orders (40 envelopes); exactly one backend matched and was terminated, the relay logged `db-connection-dropped`, stayed alive, and drained — 75 handler-log rows for 40 envelopes, no gaps or doubles. Passed in 20.6s. Proven by test, not measured: a relay on a `pg.Pool` whose backend connection is killed mid-tick keeps ticking on a fresh connection from the pool and finishes the pending row, with nothing left claimed-but-unpublished — `relay.integration.test.ts:439-486` ("a relay on a pool recovers when Postgres kills its connection"). A row already claimed when its connection dies is still re-shipped once the claim goes stale — `relay.integration.test.ts:488-530`. | on the trigger seam the enqueue fails and the trigger is gone; inside the step loop the job fails and retries with backoff up to eight attempts, then dead-letters, re-running any effect already sent. |

**Verdict: Kyu at the publish edge, level on the retry.** A dropped connection under Kyu's shipper
is recovered by the next tick on a fresh connection; under the in-house trigger seam it can drop the
trigger outright. Once a job is in the retry loop, both systems retry with backoff rather than
lose the work.

### 5. Engine outage mid-run

What is injected: the piece that actually runs handlers — Hatchet for Kyu, the same Postgres and
API process for the in-house engine — is unreachable while runs are in flight.

| | Kyu | In-house (code-level) |
|---|---|---|
| Behavior | measured by the shop failure harness, `docs/proofs/2026-09-22-shop-failure-harness.md` (scenario `engine-outage`): a harness-owned TCP proxy sat in front of the local engine's gRPC and REST ports, with both the relay and the worker routed through it. 20 orders were placed and confirmed to settle, then the proxy was cut; 20 more orders were placed, the cut was held for 5 seconds past the point the outage was first observed, then reopened. The relay logged an `error` event during the cut (`UNAVAILABLE: No connection established`) and a pending backlog was visible while cut, but the relay stayed alive throughout and so did the worker; after reopening, the outbox drained in 9065ms and all 40 order-placed envelopes across both phases settled within the report's 90-second post-reopen window. Passed in 103.5s. Structurally: `publish()` only writes the outbox row inside the caller's own transaction (`packages/sdk/src/outbox/publish.ts:71-72`); it never calls the engine, so publishing keeps working with the engine down and a backlog builds in `kyu_outbox`. The relay's ticks and any `subscribe`/`durable` handler stall until the engine returns, because both depend on it directly. | it has no separate engine, so this failure mode does not exist for it; the equivalent outage takes the API down too. |

**Verdict: the in-house engine.** This is a cost Kyu pays for the rest of this document: a piece that can go down
on its own, which the in-house design does not have at all.

### 6. 20 tenants, one hot

What is injected: 20 business tenants publish work at once; one of them accounts for most of the
volume.

| | Kyu | In-house (code-level) |
|---|---|---|
| Behavior | measured by the shop failure harness, `docs/proofs/2026-09-22-shop-failure-harness.md` (scenario `tenant-load`): at smoke size (200 orders total across 20 tenants) the fairness key holds cleanly — 16.5s (16,539ms), every effect present, every tenant's own envelopes reaching only that tenant's rows. At report size — 5,000 orders, the number issue #144 asked for — the scenario **failed**: 8,988 of the expected handler effects never appeared within the 20-minute window the scenario allows (`record-order` 2,922, `audit-order` 2,985, `send-invoice` 3,080 — spread across all three, not concentrated in one). Read directly from the engine's own task metrics for the run's window, the total was 12,948 failed tasks against 7,447 completed — roughly 60% of the expected work never completed (this figure is the pull request's review evidence, not a number the harness itself reads back). The cause is not Kyu's fairness key or the outbox: it is the engine's default five-minute schedule timeout. A task the engine cannot dispatch to a worker within five minutes of being queued is failed with no error message, `startedAt` left null, attempt stuck at 1 — exactly the shape of every failed run sampled (300 to 329 seconds between insert and finish, clustered at the five-minute mark). At this concurrency the queue grows faster than one worker can drain it, so tasks wait past the timeout and the engine fails them before they ever reach a handler — the failed runs never started, so this is a scheduling failure, not a lost or doubled effect (the outbox held every row, and nothing that did run was ever doubled). `SharedTaskOptions` (`packages/sdk/src/consume/taskOptions.ts`) exposes this as `scheduleTimeout` since #149; this run predates it. The run took 1226.5s (20.4 min) before the failure was recorded. The fairness mechanism itself is proven by test, not measured, at a smaller scale: a subscription keyed on `TENANT_CONCURRENCY_KEY` (`packages/sdk/src/consume/concurrency.ts:11`, exported `packages/sdk/src/index.ts:85`) with `strategy: 'round-robin'` gives one busy tenant (20 messages) and one quiet tenant (3 messages) each a slot, so the quiet tenant's last message lands at position 4 of 23 in the test's own recorded run — the assertion itself only bounds it below `BUSY_COUNT / 2` — while the busy tenant is still delivered in its own publish order (`packages/sdk/src/consume/concurrency.integration.test.ts`, `BUSY_COUNT`/`QUIET_COUNT` at lines 23-24, the assertions at lines 88-97). **Second run** (issue #149, pull request B): every shop subscription now sets `scheduleTimeout: '30m'`. That alone turned the first run's failure into a pass: with the *original* `KYU_SHOP_SLOTS=50`/`KYU_SHOP_DURABLE_SLOTS=200`, `tenant-load` at report size passed in 115,412ms with zero failures — the engine's own task window for that run showed `record-order`, `audit-order` and `send-invoice` each at 5,000 completed and `watch-shipping` at 1,200 completed. Lowering `KYU_SHOP_DURABLE_SLOTS` to 50 then cut the wall time to 42.0s (42,047ms); most of that difference is the worker's own shutdown with durable runs still in flight, not handler throughput — at report size 200 durable slots complete more `watch-shipping` work (1,200 runs) than 50 slots do (250), and cost more when the worker stops (a smoke-size, 200-order run took 65.1s at 50/200 against 2.7s at 50/50, and logged a `DurableEvictionManager` eviction-ack timeout only at 50/200 — that warning is teardown, not a throughput signal). At the moment each report-size run passed, the engine still held most of `watch-shipping`'s own work unfinished — 250 completed / 50 running / 4,700 queued in the builder's 50-slot run, 250 completed / 4,750 queued in the reviewer's 50-slot reproduction, 1,200 completed / 119 running / 3,681 queued in the reviewer's 200-slot run — because `assertNoLostEffect` only covers `record-order`, `audit-order` and `send-invoice`; a queued run reads `queued`, not `failed`, so `assertNoFailedRun` cannot see it, and each scenario run's fresh namespace means those queued runs are never served and dead-letter once `scheduleTimeout` elapses. Every effect the scenario does check for was present: no doubled or lost effect among the three plain handlers, no failed run, per-tenant and per-key ordering held (`docs/proofs/2026-09-22-shop-failure-harness.md`, second run). **Third run** (issue #155): the scenario now also waits for every order's durable `watch-shipping` run to reach a terminal row and times that separately from the plain-handler wait, and `runScenario` cancels any run the engine still holds queued or running in the scenario's own namespace at teardown. At `KYU_SHOP_DURABLE_SLOTS=200`, all 5,000 `watch-shipping` runs reached a terminal row in 220.5s against 49.9s for the three plain handlers (221.4s wall time), and the engine held zero queued or running runs in that namespace after teardown (`docs/proofs/2026-09-22-shop-failure-harness.md`, third run). | strict global FIFO within one priority lane, no tenant key in the claim, one job per 2 s per machine; the 19 quiet tenants queue behind the hot tenant's jobs (derived: at #144's own 5,000-event scenario, roughly 2.8 h on one machine for the trigger jobs alone, before any step jobs). The rate limit and the one-active-run-per-owner conflict are not fairness. |

**Verdict: Kyu, once the schedule timeout is sized for the load.** The first run, at the engine's
five-minute default schedule timeout, failed outright: the queue outran that timeout and 12,948 of
the run's tasks dead-lettered against 7,447 completed (the pull request's review evidence, not a
number the harness itself reads back; the failed runs never started). Issue #149 landed
`scheduleTimeout`; setting it to 30 minutes on every shop subscription is what turned that failure
into a pass on its own — with the original `KYU_SHOP_DURABLE_SLOTS=200` left unchanged, 5,000
orders across 20 tenants passed in 115.4 seconds with zero failures. Lowering
`KYU_SHOP_DURABLE_SLOTS` to 50 then cut that to 42.0 seconds, mostly by shrinking the worker's own
shutdown time, not by fixing a throughput problem: the same fairness key and per-tenant isolation
proven by test held in both configurations, with no doubled or lost effect and no failed run among
the three plain handlers (`record-order`, `audit-order`, `send-invoice`). The in-house engine has no timeout of
that kind to overflow — its single FIFO lane with no tenant key just queues behind the hot tenant,
at 0.5 jobs/s per machine, so the same 5,000 jobs take roughly 2.8 hours to drain on one machine
(derived, not measured). The 42-second figure covers those three plain handlers only. A third run
(issue #155) closed that gap: the scenario now waits for every order's durable `watch-shipping` run
to reach a terminal row as well, times that wait separately from the plain-handler wait, and
`runScenario` cancels anything the engine still holds queued or running in the scenario's own
namespace at teardown. At `KYU_SHOP_DURABLE_SLOTS=200`, all 5,000 `watch-shipping` runs reached a
terminal row in 220.5 seconds, against 49.9 seconds for the three plain handlers, and the engine
held nothing queued or running in that namespace once the run finished
(`docs/proofs/2026-09-22-shop-failure-harness.md`, third run). The honest comparison instead: Kyu's
three plain handlers cleared 5,000 orders across 20 tenants in well under a minute, each tenant
holding its own concurrency slot, which the in-house engine does not have at all, and the durable work behind
`watch-shipping` — which the in-house engine's derived number has no equivalent for — is now fully accounted for
rather than left running past the point the scenario declared a pass. The honest caveat: this is
one laptop-engine run, and a larger `KYU_SHOP_DURABLE_SLOTS` completes more durable work, not less
— it only costs more at shutdown, which is what widened the report-size wall time from 42s to 115s.

### 7. 48-hour delay with a restart

What is injected: a workflow step delays for 48 hours, and a worker restarts somewhere inside that
window.

| | Kyu | In-house (code-level) |
|---|---|---|
| Behavior | measured by the shop failure harness, `docs/proofs/2026-09-22-shop-failure-harness.md` (scenario `long-delay-handoff`): a 48-hour workflow delay was handed off to a scheduled continuation; the worker was restarted between the first run ending and the continuation being due, then the continuation's `publish_at` was fast-forwarded to now. The run finished on the second worker (pid 90631), walking `hold` → `nudge` → `finish` and publishing exactly one `shop.staff.notify`; the engine's own run history shows two separate `run-workflow` runs sharing one correlation id — the hand-off and the continuation — neither cancelled nor failed (`engineRunCount: 2`). Passed in 8.2s. Proven by test, not measured. A delay of any length is legal: at or above 60 seconds, the shop interpreter hands the wait off to a scheduled re-publish of its own trigger message, in one transaction under the step's own `onceById` guard, and the run ends holding nothing (`examples/shop/src/handlers/runWorkflow.ts:109-143`; the scheduled time is `publishAt`, an outbox column added by `packages/sdk/migrations/20260922022251_outbox_publish_at.sql:8`, and threaded through `publish(tx, definition, data, { publishAt })`, `packages/sdk/src/outbox/publish.ts:30-33,58-60,72`, PR #128). At the wake time the relay ships that row and a new run picks up where the last one left off — proven, including a worker started after the first one stopped, by `examples/shop/src/__tests__/workflowLongDelay.integration.test.ts` (`LONG_DELAY_SECONDS = 48 * 60 * 60` at line 167, and the assertion that the finishing handler ran under the second worker's own pid, lines 222,240; the test shortens the wait by moving the row's `publish_at` forward rather than waiting the 48 hours out in real time, `workflowLongDelay.integration.test.ts:224` — the same shortened-timer approach #144 itself asks for). The design is recorded in `docs/architecture/adr/20260920-workflow-definitions-run-through-one-interpreter.md:88-100` ("Addendum — 22 September 2026: how a long delay waits (#113)"). | a timestamp and a 60 s sweep, good to 365 days, restart-proof by construction. |

**Verdict: level, with a cost.** A 48-hour park is legal on Kyu today and is proven restart-proof by
a merged test, the same way the in-house one is. The honest cost sits in "Where Kyu is worse" below: a
ceiling still exists (the durable body's `executionTimeout`, 24 hours by default —
`packages/sdk/src/consume/durable.ts:266`, warned in the handler's own doc comment at `:193-198`, and 1 hour for `run-workflow` itself,
`examples/shop/src/handlers/runWorkflow.ts:419` — because a delay at or above 60 seconds never
sleeps in-process past that hand-off), and the mechanism is a hand-off across two runs rather than
one run parked the whole 48 hours. When this document was written, Kyu's own ADR addendum named a
gap this document did not solve either: a scheduled outbox row could not be recalled if the run was
cancelled mid-wait (`docs/architecture/adr/20260920-workflow-definitions-run-through-one-interpreter.md:100`,
issue #99). That gap closed on 2026-09-24. Given the caller's own transaction,
`kyu.runs.cancelForCorrelation(runId, { outbox: tx })` now also cancels every outbox row under that
id that the relay has not claimed, whether its `publish_at` is still ahead or already passed (issue
#180, PR #184; issue #185, PR #189). That is proven by
`examples/shop/src/__tests__/workflowLongDelay.integration.test.ts` ("a cancel given the outbox
cancels the continuation, so the workflow never resumes (#180)") and by
`packages/sdk/src/consume/cancelRuns.integration.test.ts` (flows 6 and 7). A row the relay has
already claimed, or one whose push the engine took but the relay recorded as failed, can still
reach the engine, as `README.md` says in its cancel paragraph, and disabling a definition between
the two runs is still not solved (the same ADR, "Addendum — 24 September 2026").

### 8. Cancel parked, cancel between steps

What is injected: an operator cancels a run while it is parked in a wait, and separately cancels a
run between one step finishing and the next one's job being claimed.

| | Kyu | In-house (code-level) |
|---|---|---|
| Behavior | measured by the shop failure harness, `docs/proofs/2026-09-22-shop-failure-harness.md` (scenario `cancel-parked`): `kyu.runs.cancelForEnvelope` was called against a `watch-shipping` run 9 seconds after its waiting row appeared — past the initial `sleepFor('5s')`, so genuinely parked in `ctx.waitFor`; `watch-shipping`'s final status read `cancelled`, and exactly one waiting row was ever written — never a completed or timed-out row. Passed in 25.0s. Measured (scenario `cancel-between-steps`): a run cancelled through `kyu.runs.cancelForCorrelation` after the first step's ledger row landed, while the run was genuinely parked in the second step's `sleepFor`, left exactly one step-log row (`first`), the run's own `finished_at` stayed null, and `shop.staff.notify` was never published (`notifyCount: 0`). Passed in 14.5s. Neither run in this harness is ever cancelled while a step is actively running, because the shop has no long-running step that is not parked — every genuine park here is inside a delay's `sleepFor` or a durable `waitFor`. Proven by test, not measured: `runs.cancelForEnvelope` and `runs.cancelForCorrelation` (`packages/sdk/src/createKyu.ts:75-82`, PR #130) reach a run by the envelope id or by every run sharing a correlation id. A run parked in `sleepFor` ends `cancelled` within 10 seconds and is never replayed; a run parked in `waitFor` does the same — `packages/sdk/src/consume/cancelRuns.integration.test.ts:158-193` ("flow 1" and "flow 2"). Cancelling by correlation id takes every run under that id and leaves another correlation alone — `cancelRuns.integration.test.ts:195-223` ("flow 3"). Progress and a parked run's own wait are read back through `runs.forCorrelation` (`createKyu.ts:74`, `packages/sdk/src/consume/runProgress.ts:29-52`, PR #135). Added on 2026-09-24, after this document was written: `runs.unsettledForTenant` and `runs.cancelForTenant` (`packages/sdk/src/createKyu.ts:85-86`, issue #182, PR #187) read or cancel one business tenant's queued or running runs in this namespace, matched on the `tenantId` run metadata the relay copies from the envelope, never another tenant's or another namespace's — proven by `packages/sdk/src/consume/namespaceRuns.integration.test.ts` ("cancels tenant A in this namespace and leaves tenant B and the other namespace alone, runs and outbox rows"). One `cancelForTenant` call is a request, not a settlement: a caller that must see the tenant empty repeats it and polls `unsettledForTenant` until it returns nothing. Given the caller's transaction as `{ outbox: tx }`, all three cancels also cancel the matching outbox rows the relay has not claimed (issues #180, #182 and #185; PRs #184, #187 and #189); a row the relay has already claimed, or one whose push the engine took but the relay recorded as failed, can still reach the engine (`README.md`, the cancel and tenant cancel paragraphs). `runs.cancelUnsettledInNamespace` (`createKyu.ts:84`, issue #155, PR #156) cancels every queued or running run in the namespace since a `since` time — one project's whole environment — and is for operations, not an ordinary cancel. | a parked run stops instantly, because there is no job to chase; a cancelled run's already-queued step job claims nothing, because the claim requires a `running` run and the handler no-ops; a run cancelled mid-step has the ledger record discarded but the side effect already happened. |

**Verdict: level on semantics, the in-house engine still ahead on reach, by less than when this document was written.** Both systems cancel a parked run cleanly and both leave an already-sent side effect sent. When this document was written, the in-house engine reached further: three cancel scopes — one run, every run of one flow, and every run of a tenant — plus a monitor UI, against Kyu's two, by id and by correlation. The tenant gap closed on 2026-09-24: `kyu.runs.cancelForTenant` cancels one business tenant's runs (issue #182, PR #187), and `kyu.runs.cancelUnsettledInNamespace` (issue #155, PR #156) already cancelled a whole namespace. The in-house engine still has three things Kyu does not. The first is the monitor UI. The second is one call that cancels every run of one flow; Kyu's nearest is one workflow run at a time, by correlation id. The third is a tenant cancel that is one transaction in the consuming project's own database; Kyu's is a request to the engine, not a settlement, it reaches only this namespace's runs from the `since` time the caller passes, and with `outbox` it still lets a row the relay has already claimed, or one whose push the engine took but the relay recorded as failed, reach the engine. Neither tenant cancel is a pause: on Kyu, `kyu.tenants.pause` (issue #181, PR #186) is the separate call that stops new work, compared in the list under "Where Kyu is worse" below.

### 9. 50,000-row backlog drain

What is injected: 50,000 rows of work are already queued, and nothing else is happening.

| | Kyu | In-house (code-level) |
|---|---|---|
| Behavior | measured by the shop failure harness, `docs/proofs/2026-09-22-shop-failure-harness.md` (scenario `outbox-backlog`): 50,000 outbox rows were queued with the relay stopped, then the relay started alone with no worker running. The backlog drained fully in 50221ms — 996 rows/sec — sampled once a second throughout (49 samples), peaking at 50,000 pending rows and a 49.3-second oldest-row age right before the drain began, and 0 pending by the end. This is slower than a solo confirmation run of this scenario alone (5,000 rows, 3,017ms, 1,657 rows/sec, against a freshly started engine) and the plan's own isolated measurement of roughly 1,770 rows/sec, because this scenario ran last in a 35-minute session, after nine other scenarios' own registrations and traffic, not against a freshly started one; the relay's own push path is not otherwise rate-limited by scenario order. | 0.5 jobs/s per machine, from batch 1 and a 2 s poll — roughly 27.8 hours for 50,000 rows on one machine (derived), with the sweep competing for the same single slot. |

**Verdict: Kyu, by a wide margin.** The harness measured Kyu's relay draining 50,000 rows in 50.2s (996 rows/sec, scenario `outbox-backlog`, `docs/proofs/2026-09-22-shop-failure-harness.md`), against the in-house engine's derived 27.8 hours for the same 50,000 rows on one machine. The in-house engine's ceiling is already visible: throughput scales only if the operator adds API machines, and the sweep shares that one slot per machine with ordinary work.

## Where Kyu is worse

Where the in-house engine costs less or does more:

- **One more deployable per project.** The in-house queue is a table in Postgres it already runs; Kyu
  needs a Hatchet container run and upgraded on its own schedule.
- **A database for the engine itself, on top of the app database.** The outbox lives in the
  consumer's own database connection alongside the business data
  (`examples/shop/src/bin/migrate.ts:20` applies the SDK and shop migrations into one database;
  `examples/shop/src/handlers/runWorkflow.ts:113-140` writes the outbox row and the ledger row in
  one transaction) — that part is not a second database. Hatchet itself is: it runs its own
  Postgres to operate, upgrade and back up (`infra/hatchet/compose.yaml:17-18`), and the relay is a
  separate process per project that needs both the app database's credentials and an engine token.
- **A real execution ceiling exists.** `durable()` defaults `executionTimeout` to 24 hours
  (`packages/sdk/src/consume/durable.ts:266`, warned at `:193-198`), and the shop's own `run-workflow` sets it to 1 hour
  (`examples/shop/src/handlers/runWorkflow.ts:419`). A delay at or above the 60-second hand-off
  threshold never counts against that ceiling, because the run ends and a scheduled publish
  restarts it — but that is two runs standing in for one. When this document was written,
  cancelling a run mid-wait could not recall the scheduled row (Kyu's own open question, issue #99,
  cited above); since 2026-09-24 a cancel given the caller's transaction retires it, unless the
  relay has already claimed it or already pushed it to the engine (issues #180 and #185, PRs #184
  and #189).
- **The queue-wait ceiling is real, and sizing it is the operator's job.** `scheduleTimeout`
  (issue #149) is what turned scenario 6's failure into a pass, but it is not free: a value large
  enough to survive a backlog is also a value that lets work sit queued that long before it
  dead-letters, and the worker sizing that went with it — fewer durable slots, not more — was not
  the change the original plan expected to need (scenario 6 above).
- **Operational unfamiliarity.** Nobody on this team has carried a Hatchet outage in production
  yet. Postgres, the team has carried for years.
- **An outage of the engine is a failure mode the in-house design does not have at all.** Scenario 5,
  above, is a cost only Kyu pays.

What the in-house engine does better, plainly, and Kyu does not have:

- A run ledger that is also the product's own monitor UI, polled every 10 seconds.
- A cancel for every run of one flow, and a tenant cancel that is one transaction in the consuming project's own database. When this document was written Kyu had no tenant cancel at all. Since 2026-09-24 it has `kyu.runs.cancelForTenant` (issue #182, PR #187), but that is a request to the engine, not a settlement, it covers only this namespace from a `since` time, and Kyu still has no single call that cancels every run of one workflow definition.
- A pause that holds a tenant everywhere at once, in-flight runs included: one flag in the one database every step reads, checked before each step is claimed, so a running flow waits at its next step until the tenant is re-enabled. When this document was written Kyu had no pause. Since 2026-09-24 `kyu.tenants.pause` (issue #181, PR #186) holds a tenant's new messages, but in the outbox of the one producer database it runs against, not in the engine: another service that publishes for the same tenant from its own database keeps shipping until it is paused there too, a row the relay had already claimed when the pause committed still ships, and a run already in the engine carries on to its end (`README.md`, "Tenant pause"). It is proven by `packages/sdk/src/outbox/tenantPause.integration.test.ts` ("holds a paused tenant’s new messages in the outbox while other work completes, then delivers them in publish order after resume") and exercised against the shop by the harness scenario `tenant-paused` (`examples/shop/README.md`).
- Parks measured in months by construction (365 days), not a hand-off across
  runs.
- Rate limits stored per tenant: tenant actions per hour and lead actions per day come from that tenant's own settings row on every costly step, counted across all costly actions together. When this document was written Kyu could only key a limit with a CEL expression over engine fields. Since 2026-09-24 a subscription can declare `rateLimit: { per: 'tenant' | 'correlation' | 'field', limit, window }` in product units (issue #183, PR #188; `packages/sdk/src/consume/rateLimits.integration.test.ts`, "rateLimit per tenant: a tenant's third run in a minute waits while another tenant runs at once"), but its `limit` is one number fixed on the subscription, the same for every tenant, and it counts that subscription's own runs unless the explicit `rateLimits` form names a shared key. A message with no `tenantId` under `per: 'tenant'`, or without the field under `per: 'field'`, fails its run at once into the dead letter rather than being counted (`README.md`, the rate-limit paragraph).

## What moving would change for the consuming project

What survives untouched: the five flow tables, the definition schema and its validator, the
repositories, the resolvers, the permissions model, and the whole builder UI. None of that is a
queue concern.

What collapses: the step handler, the interpreter's resume half, the wake arm of the sweep,
the step enqueue and its coalescing index, and the claim-token machinery that revalidates ownership
before every dispatch — roughly 800 lines of engine code, replaced by one durable handler that
reads the definition and walks it, the same shape `run-workflow` already is in the shop example.

The seven executors — `notify`, `create_task`, `export_dashboard`, `send_internal_email`, and the
rest — become ordinary command handlers. Today, each one either owns its own idempotency or admits
it has none: four of seven carry `idempotent: false`, though one of those four (`create_task`)
guards itself with its own marker, so three actually double on a retry (cited above). On Kyu, that
becomes one thing: idempotent once, by
envelope id, through `onceById`, the same guard every step in the shop's own interpreter already
uses.

The trigger seams become a `publish()` inside the caller's own transaction. That removes the 5
second deferral that only narrows the rollback gap, and the swallowed enqueue failure — because the row is written in the same transaction as the business
change that caused it, or it is not written at all.

## The decision and what would reverse it

The CTO decided on 2026-09-21 that the consuming project's flows run on Kyu. The engine's author had evaluated and
rejected an external workflow engine earlier, because it would be a second control plane to
operate; this repository does not record that evaluation. Kyu's own choice of Hatchet is recorded in
`docs/architecture/adr/20260916-hatchet-is-the-engine.md`. This document does not overturn either
position. It prices them.

What would reverse the decision, concretely:

- A park longer than what a stored deadline plus a scheduled re-publish can express. Nothing found
  in this reading needs that; the 48-hour scenario above is legal today.
- A Hatchet outage in the first quarter after the move that costs more than the cost of the in-house engine's own
  head-of-line blocking under one hot tenant would have.
- Issue #149 not landing, or landing and not fixing it — **resolved**: #149 has landed as
  `scheduleTimeout`, and the re-run of scenario 6 at report size (5,000 events,
  `KYU_SHOP_SLOTS=50`/`KYU_SHOP_DURABLE_SLOTS=50`) passed in 42.0 seconds. This risk no longer
  applies.
- A measured fairness fix in its own queue, without adopting a second engine to do it, at the
  scale scenario 6 measured.
