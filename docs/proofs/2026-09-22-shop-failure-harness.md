# Proof: the shop's failure harness (issue #144)

What this is: a written record of one run of `examples/shop/src/__tests__/harness/` against the local Hatchet engine, at the scale the issue asked for. Ten scenarios: four crash scenarios shipped in #147 (relay killed before mark, worker killed mid-step, worker killed while parked, relay's database connection dropped), and six more in this pull request (engine outage, tenant load, a 48-hour delay hand-off, two cancels, and a backlog drain).

## How this was produced

```
pnpm --filter @kyuworks/shop build
node examples/shop/dist/bin/migrate.js
pnpm --filter @kyuworks/shop harness --scenario all --size report --out report.json
```

- Commit: the working tree that became `f51687038b36e5ec0f1f6e37bcef777eb26f10ff` — `git rev-parse HEAD` read `88777d1504766fef1282525eb4c4bf10b8d56f2f` at run time, but the tree was dirty with the scenario fixes (`scenario.ts`, `engineOutage.ts`, `longDelayHandoff.ts`, `outboxBacklog.ts`) that this same commit carries. `report.ts` now appends `-dirty` to the recorded sha when `git status --porcelain` is non-empty, so a future run states this on its own instead of needing a manual correction here.
- Machine: Apple M5, 10 CPUs, 32 GB RAM, macOS 26.5.1 (build 25F80), arm64
- Docker Desktop VM memory: 1.9 GB
- Engine: `ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest` (the local engine's `/api/v1/meta` carries no version field; the harness's own `report.ts` falls back to the compose image tag)
- Lane database: `kyu_shop_lane144` (an isolated database, not the shop's own)
- Every scenario in this run got its own namespace — the lane's namespace plus the scenario's name plus a random suffix minted fresh each run (`scenario.ts`'s `scenarioNamespace`) — so a run left parked by one scenario can never be picked up by another scenario's worker. This is how the "chained runs" carry-over from #147's review is closed; see Deviations in the pull request body for why a per-scenario-run suffix, not just a per-scenario name.

Each scenario was also run alone at `--size smoke` first and confirmed green before this report run; those logs are not part of this proof (they are a local development step, not part of the written record).

## Results

Nine of ten scenarios passed. `tenant-load` failed at the full size in this run; see its own section below for why, and for what that failure means. A second run of `tenant-load` alone, after issue #149 shipped `scheduleTimeout` and the worker's durable-slot setting was retuned, passed at the same size — also recorded in that scenario's own section.

| Scenario | Result | Duration |
|---|---|---|
| `relay-killed-before-mark` | PASS | 40.1s |
| `worker-killed-mid-step` | PASS | 58.4s |
| `worker-killed-while-parked` | PASS | 49.9s |
| `relay-db-connection-dropped` | PASS | 20.6s |
| `engine-outage` | PASS | 103.5s |
| `tenant-load` | **FAIL** | 1226.5s (20.4 min) |
| `long-delay-handoff` | PASS | 8.2s |
| `cancel-parked` | PASS | 25.0s |
| `cancel-between-steps` | PASS | 14.5s |
| `outbox-backlog` | PASS | 51.0s |

### relay-killed-before-mark

What was injected: a relay child (`relayMarkKiller.js`) that SIGKILLs itself on the exact SQL statement that would mark a row published, between pushing 20 orders' worth of envelopes (40 envelopes: `shop.order.placed` + `shop.invoice.send`) and marking them. A second, real relay is then started to reclaim the row once its claim goes stale.

What was observed: the killer fired and died by `SIGKILL`; the reclaim took 30189ms against a 30000ms `staleClaimMs`, i.e. right at the edge, as designed — a claim only becomes reclaimable once it is *older* than the stale window. The engine's own run history shows the redelivery the design expects: 6 duplicate engine-side runs for the one envelope the race hit (`engineDuplicateCountForOrderPlaced: 6`), and every one of them still produced exactly one effect (`assertNoDoubleEffect`, `assertNoFailedRun` both held). 85 handler-log rows for 40 envelopes (record-order + audit-order per order-placed, send-invoice per invoice) — no gaps, no doubles.

### worker-killed-mid-step

What was injected: a worker SIGKILLed while `watch-shipping` is still inside its `sleepFor('5s')`, before it has genuinely parked.

What was observed: the redelivered run finished on a second worker (pid 90398), with `watch-shipping:timeout` as its terminal row (the 8s watch timeout this scenario sets is shorter than the order ever gets shipped). Exactly one waiting row, exactly one terminal row, no failed runs.

### worker-killed-while-parked

What was injected: a worker SIGKILLed only once `watch-shipping` is genuinely parked in `ctx.waitFor` (past the sleep). The order is then shipped while no worker is running, and a second worker picks the durable run back up.

What was observed: the completed row's `pid` matches the second worker (90471), the recorded carrier (`ups`) matches what was shipped, and no run failed.

### relay-db-connection-dropped

What was injected: `pg_terminate_backend` against the relay's own Postgres connection while it is mid-tick, for 20 orders (40 envelopes).

What was observed: exactly one backend matched and was terminated, the relay logged `db-connection-dropped`, stayed alive, and drained: 75 handler-log rows for 40 envelopes, no gaps or doubles.

### engine-outage

What was injected: a harness-owned TCP proxy in front of the local engine's gRPC (7077) and REST (8888) ports (`proxy.ts`), with relay and worker both routed through it via `HATCHET_CLIENT_HOST_PORT` / `HATCHET_CLIENT_API_URL`. 20 orders were placed while the proxy was open and confirmed to settle, then the proxy was cut, 20 more orders were placed, the cut was held for 5 seconds past the point the outage was first observed, then the proxy reopened.

What was observed: the relay logged an `error` event during the cut (`UNAVAILABLE: No connection established`) and a pending backlog was visible while cut — both signals the outage happened. The relay stayed alive throughout (`relayStayedAliveDuringCut: true`, `relayAliveAtEnd: true`); so did the worker. After reopening, the outbox drained in 9065ms and every one of the 40 order-placed envelopes across both phases (before and during the outage) settled its record-order/audit-order effects within the 90-second post-reopen window this scenario allows for the worker's own gRPC client to reconnect on its own backoff. Red proof for this scenario (the outage assertion actually biting) is in the pull request body, not repeated here.

**Deviation from the naive proxy behaviour, worth recording:** the worker's own gRPC client backs off its reconnect independently of the relay's outbox poll, and needs noticeably longer than the relay does to resume sending actions. A cut reopened the instant the outage is merely observed does not give that backoff anywhere to land, so this scenario holds the cut open for a further 5 seconds and allows 90 seconds (not 30) for post-reopen settlement — both wider than the relay-only proxy proof in the plan assumed, because that proof did not route the worker through the same cut at the same time as the relay.

### tenant-load — FAILED at report size

What was injected: 20 tenants publishing at once (one large tenant, nineteen small ones at 5 orders each), against a worker sized up with this pull request's sibling change (`KYU_SHOP_SLOTS=50`, `KYU_SHOP_DURABLE_SLOTS=200`). Smoke size is 200 total orders; report size is 5,000, the number the issue asked for.

At smoke size (200 orders) this passes cleanly in 16.5 seconds (16,539ms — the `--scenario all --size smoke` run made to confirm the whole suite before this report run, not a solo run of this scenario alone), every effect present, every tenant's own envelopes reaching only that tenant's rows.

At report size (5,000 orders) it failed: 8,988 handler effects never appeared within the 20-minute window this scenario allows (spread almost evenly across `record-order` 2,922, `audit-order` 2,985 and `send-invoice` 3,080 — not concentrated in one handler). The scenario's own run-outcome check samples 200 of the 5,000 order-placed envelope ids (`runOutcomeSampleSize` / `runOutcomeSampledOfTotal`, said again below); within that 200-envelope sample, 397 engine runs read back `failed` with no error message (155 `watch-shipping`, 123 `audit-order`, 119 `record-order`) — a per-subscription breakdown over the sample, not the total, and one that leaves out `send-invoice` because only order-placed ids are sampled. Read directly from the engine's own task metrics for the run's window, rather than through the shop's tables, the total was 12,948 failed tasks against 7,447 completed (this pull request's review evidence; the harness itself does not make this call). Roughly 60% of the expected work never completed.

**This is not a delivery-guarantee failure.** Nothing here contradicts must-hold: the outbox held every row until it was genuinely pushed (the relay's own progress is unaffected by worker load), and no effect that *did* run was ever doubled. What failed is throughput at this concurrency. The cause is the engine's default schedule timeout, not the worker's own database pool: a task the engine cannot dispatch to a worker within five minutes of being queued is failed with no error message, `startedAt` left null, attempt stuck at 1 — exactly the shape of every failed run sampled (300 to 329 seconds between insert and finish, clustered right at the five-minute mark). At report size the queue grows faster than one worker can drain it, so tasks wait past that mark and the engine fails them before they ever reach a handler. This is not pool exhaustion: in the review's own re-run, the lane database held roughly 4 to 14 connections at a time, at most one of them active — well short of the worker's 10-connection pool (this pull request's review evidence, not the reported run; the harness itself records no connection counts). `SharedTaskOptions` (`packages/sdk/src/consume/taskOptions.ts`) exposes this as `scheduleTimeout` since #149; this run predates it. A follow-up to raise it, or to size the worker for this load, is flagged separately in the pull request body; it is an SDK or shop change, out of scope for this harness/proof pull request.

The plan's own throughput estimate (~16 minutes for 5,000 events, extrapolated linearly from a 100-event, 19.3-second sample at the same slot counts) undershot what was actually observed: 20.4 minutes and, by then, still short on completed work. The extrapolation assumed throughput stays flat as concurrency rises from "mostly under 10 in flight" to "up to 260 in flight"; the engine's five-minute schedule timeout above is the most likely reason it does not — once the queue backs up past that mark, work starts failing outright rather than merely slowing down.

**The issue's numbers are not being shrunk here.** This scenario was run once, at the full 5,000-event size the issue names, and it failed. That failure, and the diagnosis above, is the honest result of running it at that size.

**Update:** the SDK now exposes this as `scheduleTimeout` on a subscription (issue #149). This scenario has not been re-run. Raising the timeout stops the dead-lettering, but at 5,000 orders the queue is roughly 20,000 runs against the five runs per second this machine managed, so the scenario would then miss its own 20-minute window instead. Re-running it, with that window and the shop's own `scheduleTimeout` values chosen together, is its own change.

**Second run, 2026-09-22 (issue #149, pull request B) — PASSED at report size.** Every shop subscription (`record-order`, `audit-order`, `send-invoice`, `watch-shipping`, `run-workflow`) now sets `scheduleTimeout: '30m'`, well above the engine's own five-minute default. That alone is what turned the first run's failure into a pass: with the *original* `KYU_SHOP_SLOTS=50` / `KYU_SHOP_DURABLE_SLOTS=200` from the first run unchanged, `tenant-load` at report size (5,000 orders) passed in 115,412ms with zero failures — the engine's own task window for that run showed `record-order`, `audit-order` and `send-invoice` each at 5,000 completed and `watch-shipping` at 1,200 completed (`docs/proofs/data/report-review-149b-50-200.json`). Lowering `KYU_SHOP_DURABLE_SLOTS` to 50 then cut the report-size wall time from 115s to 40s (`docs/proofs/data/report-149b-report-5050-attempt1.json`, 42,047ms); most of that difference is scenario teardown, not handler throughput. At smoke size (200 orders), 50 plain slots with 200 durable slots took 65.1s (65,101ms) and logged a `DurableEvictionManager: failed to send eviction … Eviction ack timed out after 30000ms` warning; 50 plain / 50 durable slots took 2.7s (2,685ms) with no such warning. `durationMs` brackets the pre-run table truncate through the tracked children stopping and the post-run truncate (`scenario.ts`, around lines 228 and 279) — in the 50/200 smoke run the engine finished every plain task about 4.5 seconds in, and the remaining roughly 60 seconds is the worker stopping with 200 durable runs still in flight, which is where the eviction-ack warning comes from. That warning is a teardown cost, not a throughput signal. A larger `KYU_SHOP_DURABLE_SLOTS` completes more durable work, not less: at report size, 200 durable slots completed 1,200 `watch-shipping` runs against 50 slots' 250, and the larger count simply costs more when the worker stops.

With the same candour as the sampling caveat below: at the moment each of these report-size runs was declared a PASS, the engine still held most of `watch-shipping`'s own work unfinished — 250 completed / 50 running / 4,700 queued in the builder's 50-slot run, 250 completed / 4,750 queued in the reviewer's 50-slot reproduction, 1,200 completed / 119 running / 3,681 queued in the reviewer's 200-slot run. `assertNoLostEffect` only requires rows for `record-order`, `audit-order` and `send-invoice`; `watch-shipping` is not required to produce a row, and a queued run reads `queued`, not `failed`, so `assertNoFailedRun` cannot see it either. Each scenario run uses a fresh random namespace, so no worker will ever serve those queued `watch-shipping` runs — they dead-letter once the 30-minute `scheduleTimeout` elapses.

At report size (5,000 orders, the number the issue asked for), `tenant-load` with `KYU_SHOP_SLOTS=50` / `KYU_SHOP_DURABLE_SLOTS=50` and `scheduleTimeout: '30m'` on every subscription **passed** in 42.0s (42,047ms) — well inside the 20-minute window this scenario allows, and well inside 30 minutes, the `scheduleTimeout` value itself. Every failure check the scenario makes held: no doubled effect, no failed run (across the 200-envelope run-outcome sample), no lost effect for either `record-order`/`audit-order` or `send-invoice`, the outbox settled, per-key ordering held, and every one of the 20 tenants' own envelopes reached only that tenant's rows. `handlerRowCount` read 15,550 for 5,000 orders, roughly 370 handler-log rows/sec (roughly 119 orders/sec). Same machine, engine, and Docker memory ceiling as the rest of this document; run alone with the engine to itself, not part of a `--scenario all` session. This run's own JSON records `commitSha: "0a1ac11c451f641028d2aa5a3babf8e1394e9d7e-dirty"` — the working tree that became this pull request, not this pull request's own head; the 200-durable-slot report-size run cited above was recorded against `641a6f95bdf5fa4b094af8eeef49d371089fb4fb-dirty`, this pull request's actual head, with an uncommitted change at run time. JSON: `docs/proofs/data/report-149b-report-5050-attempt1.json` (50/50, report size, the passing run measured just above), `docs/proofs/data/report-review-149b-50-200.json` (50/200, report size, the 115,412ms run above it). The smoke-size numbers behind the 65.1s/2.7s figures were confirmation runs made along the way, not part of this written record, and are not committed here.

This closes acceptance criterion 3 of issue #149.

### long-delay-handoff

What was injected: a 48-hour workflow delay, which the interpreter hands off to a scheduled continuation instead of parking in-process (issue #113's `DELAY_HANDOFF_SECONDS`). The worker is restarted between the first run ending and the continuation being due, then the continuation's `publish_at` is fast-forwarded to now, the same technique `workflowLongDelay.integration.test.ts` uses.

What was observed: exactly one continuation row, unpublished, with a `publish_at` 48 hours out, before the restart. After the restart and the fast-forward, the run finished on the second worker (pid 90631), walking `hold` → `nudge` → `finish`, publishing exactly one `shop.staff.notify`. The engine's own run history shows two separate `run-workflow` runs sharing one correlation id — the hand-off and the continuation — neither cancelled nor failed (`engineRunCount: 2`).

### cancel-parked

What was injected: `kyu.runs.cancelForEnvelope` against a `watch-shipping` run 9 seconds after its waiting row appears — past the initial `sleepFor('5s')`, so genuinely parked in `ctx.waitFor`, not merely mid-step.

What was observed: the cancel returned 3 run outcomes (record-order, audit-order, watch-shipping — every run the envelope ever triggered), `watch-shipping`'s final status read `cancelled`, and exactly one waiting row was ever written — never a completed or timed-out row. `record-order` and `audit-order`, which finish in well under a second, were unaffected by the cancel (the engine leaves an already-finished run untouched).

### cancel-between-steps

What was injected: a seeded two-delay-step workflow (a short first delay, then a 20-second second delay), cancelled through `kyu.runs.cancelForCorrelation` after the first step's ledger row lands and while the run is genuinely parked in the second step's `sleepFor` — before it ever reaches its notify step.

What was observed: exactly one step-log row (`first`), the run's own `finished_at` stayed null, and `shop.staff.notify` was never published (`notifyCount: 0`). The engine's own run history shows the `run-workflow` run read `cancelled`.

**What this does not prove, said plainly (the issue's own "cancel between two steps" framing):** the shop has no long-running step that is not parked. This scenario lands the cancel in the one genuine park a workflow run has here — inside a delay step's `sleepFor`, after an earlier step has already recorded — not while a step is *actively running*. There is no step in this interpreter that runs long enough, unparked, to cancel mid-execution.

### outbox-backlog

What was injected: 50,000 outbox rows (a real `shipOrder` publish, cloned 49,999 times with a fresh `uuidv7()` envelope id per clone — every clone's outbox row id set to that same envelope id, matching what a real publish writes, which is what lets the relay's own `markPublished` find and settle each one), with the relay stopped, then started alone with no worker.

What was observed: the backlog drained fully in 50221ms — 996 rows/sec — sampled once a second throughout (49 samples), peaking at 50,000 pending rows and a 49.3-second oldest-row age right before the drain began, and 0 pending by the end. This is slower than a solo `--size smoke` confirmation run of this scenario alone (5,000 rows, 3,017ms, 1,657 rows/sec — a standalone run against a freshly started engine, not part of this report's own JSON) and the plan's own isolated measurement of ~1,770 rows/sec (`throughput.sh`, also run alone against a freshly started engine): this scenario ran ninth in a 35-minute session on one engine, after nine other scenarios' own registrations and traffic, not against a freshly started one. The relay's own push path is not otherwise rate-limited by scenario order; the difference is engine-side accumulated load, not a regression in the relay itself.

**Two things learned building this scenario, both now load-bearing comments in `outboxBacklog.ts`:** the relay parses every envelope with the SDK's own schema before it will push a row, so a clone's `id` must be a genuine uuidv7, not a `gen_random_uuid()` v4 — an invalid id left every clone sitting `skipped` forever. And the relay's `markPublished` matches claimed rows by the *envelope's own* `id` field, not a separately generated primary key — a clone whose outbox row id differed from its envelope's id looked like it pushed successfully on every tick (`pushed:100` every 100ms) while never actually settling, because the `UPDATE ... WHERE id = ANY(...)` never matched anything.

## What this harness does not prove

- **Cancel-between-steps never cancels a step that is actually executing.** The shop's workflow interpreter has no long-running, unparked step; every genuine park here is inside a delay's `sleepFor` or a durable `waitFor`. See that scenario's own section above.
- **The load numbers are a laptop engine, not a production one.** `tenant-load` at 5,000 events surfaced a real capacity ceiling in its first run — the engine's default five-minute schedule timeout, which fails a queued task before it ever reaches a worker once the queue backs up past that mark (see the scenario's own section above). Issue #149 has since shipped `scheduleTimeout`, and a second run at the same size with it set to 30 minutes passed (at both 200 and 50 durable slots). The numbers in this report, including that second run, are honest for this machine, this engine, these settings; they are not a claim about any other deployment.
- **The double-effect detector relies on the schema, not on the harness reading every row by hand.** `assertNoDoubleEffect` catches a doubled `shop_workflow_run` or a doubled `shop.staff.notify`, but a doubled `shop_handler_log` write for one envelope and handler is caught differently: `shop_handler_log_once_idx`'s unique index turns that into a failed run on the engine side before a second row can ever appear, and `assertNoFailedRun` is what actually sees it. If that index were ever dropped, a genuine double write there would no longer surface as a failure this harness catches.
- **`tenant-load`'s run-outcome check samples, not reads every envelope, at report size.** 5,000 per-envelope engine reads, even batched at a concurrency of 20, is too slow to be worth it; the check samples 200 envelope ids spread evenly across the run and says so in its own observation (`runOutcomeSampleSize` / `runOutcomeSampledOfTotal`). The doubled/lost-effect checks stay exhaustive — they are plain SQL over the shop's own tables, not engine reads.
- **`tenant-load` neither waits for nor asserts `watch-shipping`'s own durable effects.** `assertNoLostEffect` only covers `record-order`, `audit-order` and `send-invoice`; at the moment either report-size second-run PASS above was declared, the engine held `watch-shipping` at 250 completed at 50 durable slots, 1,200 at 200, the rest still running or queued (up to 4,750). A queued run reads `queued`, not `failed`, so `assertNoFailedRun` cannot see it, and because each scenario run uses a fresh random namespace those queued runs are never served by any worker — they dead-letter once `scheduleTimeout` elapses, unobserved by this harness.
- **This harness is never run by CI.** It is a hand-run proof, not a regression gate. A future run against a different engine version, a different machine, or a different Docker memory ceiling would produce different numbers, especially for `tenant-load` and `outbox-backlog`.
