# Proof: the shop's failure harness (issue #144)

What this is: a written record of one run of `examples/shop/src/__tests__/harness/` against the local Hatchet engine, at the scale the issue asked for. Ten scenarios: four crash scenarios shipped in #147 (relay killed before mark, worker killed mid-step, worker killed while parked, relay's database connection dropped), and six more in this pull request (engine outage, tenant load, a 48-hour delay hand-off, two cancels, and a backlog drain).

## How this was produced

```
pnpm --filter @kyuworks/shop build
node examples/shop/dist/bin/migrate.js
pnpm --filter @kyuworks/shop harness --scenario all --size report --out report.json
```

- Commit: `88777d1504766fef1282525eb4c4bf10b8d56f2f`
- Machine: Apple M5, 10 CPUs, 32 GB RAM, macOS 26.5.1 (build 25F80), arm64
- Docker Desktop VM memory: 1.9 GB
- Engine: `ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest` (the local engine's `/api/v1/meta` carries no version field; the harness's own `report.ts` falls back to the compose image tag)
- Lane database: `kyu_shop_lane144` (an isolated database, not the shop's own)
- Every scenario in this run got its own namespace — the lane's namespace plus the scenario's name plus a random suffix minted fresh each run (`scenario.ts`'s `scenarioNamespace`) — so a run left parked by one scenario can never be picked up by another scenario's worker. This is how the "chained runs" carry-over from #147's review is closed; see Deviations in the pull request body for why a per-scenario-run suffix, not just a per-scenario name.

Each scenario was also run alone at `--size smoke` first and confirmed green before this report run; those logs are not part of this proof (they are a local development step, not part of the written record).

## Results

Nine of ten scenarios passed. `tenant-load` failed at the full size; see its own section below for why, and for what that failure means.

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

At smoke size (200 orders) this passes cleanly in 16.5 seconds, every effect present, every tenant's own envelopes reaching only that tenant's rows.

At report size (5,000 orders) it failed: 8,988 handler effects never appeared within the 20-minute window this scenario allows (spread almost evenly across `record-order` 2,922, `audit-order` 2,985 and `send-invoice` 3,080 — not concentrated in one handler), and 397 engine runs read back `failed` with no error message (155 `watch-shipping`, 123 `audit-order`, 119 `record-order`). Roughly 60% of the expected work never completed.

**This is not a delivery-guarantee failure.** Nothing here contradicts must-hold: the outbox held every row until it was genuinely pushed (the relay's own progress is unaffected by worker load), and no effect that *did* run was ever doubled. What failed is throughput at this concurrency, and the most likely cause is not this harness's own code: `examples/shop/src/worker.ts` opens its Postgres pool with `createPool(config.databaseUrl)` and no `max`, so it defaults to `pg-pool`'s built-in ceiling of 10 connections — regardless of `KYU_SHOP_SLOTS` / `KYU_SHOP_DURABLE_SLOTS`. Every handler takes a connection from that same pool for its `withTransaction`. Raising the slot counts to 50/200 raises how much work the worker will *accept* concurrently; it does nothing to how much of that work the database can actually serve at once. At 200 orders that ceiling is rarely the bottleneck; at 5,000 it plausibly is — this matches the almost-even spread across every handler type, all of which share the one pool, rather than a pattern specific to the durable `watch-shipping` path. A follow-up to size the worker's pool from the same config is flagged separately; it is a shop-only change, out of scope for this harness/proof pull request.

The plan's own throughput estimate (~16 minutes for 5,000 events, extrapolated linearly from a 100-event, 19.3-second sample at the same slot counts) undershot what was actually observed: 20.4 minutes and, by then, still short on completed work. The extrapolation assumed throughput stays flat as concurrency rises from "mostly under 10 in flight" to "up to 260 in flight"; the pool ceiling above is the most likely reason it does not.

**The issue's numbers are not being shrunk here.** This scenario was run once, at the full 5,000-event size the issue names, and it failed. That failure, and the diagnosis above, is the honest result of running it at that size.

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

What was observed: the backlog drained fully in 50221ms — 996 rows/sec — sampled once a second throughout (49 samples), peaking at 50,000 pending rows and a 49.3-second oldest-row age right before the drain began, and 0 pending by the end. This is slower than the smoke-size run's 1,657 rows/sec (5,000 rows) and the plan's own isolated measurement of ~1,770 rows/sec (`throughput.sh`, run alone against a freshly started engine): this scenario ran ninth in a 35-minute session on one engine, after nine other scenarios' own registrations and traffic, not against a freshly started one. The relay's own push path is not otherwise rate-limited by scenario order; the difference is engine-side accumulated load, not a regression in the relay itself.

**Two things learned building this scenario, both now load-bearing comments in `outboxBacklog.ts`:** the relay parses every envelope with the SDK's own schema before it will push a row, so a clone's `id` must be a genuine uuidv7, not a `gen_random_uuid()` v4 — an invalid id left every clone sitting `skipped` forever. And the relay's `markPublished` matches claimed rows by the *envelope's own* `id` field, not a separately generated primary key — a clone whose outbox row id differed from its envelope's id looked like it pushed successfully on every tick (`pushed:100` every 100ms) while never actually settling, because the `UPDATE ... WHERE id = ANY(...)` never matched anything.

## What this harness does not prove

- **Cancel-between-steps never cancels a step that is actually executing.** The shop's workflow interpreter has no long-running, unparked step; every genuine park here is inside a delay's `sleepFor` or a durable `waitFor`. See that scenario's own section above.
- **The load numbers are a laptop engine, not a production one.** `tenant-load` at 5,000 events surfaced a real capacity ceiling — most likely the worker's Postgres pool staying fixed at 10 connections regardless of slot count — that a production-sized deployment, and a worker whose pool scales with its slots, would not necessarily hit. The numbers in this report are honest for this machine, this engine, this pool size; they are not a claim about any other deployment.
- **The double-effect detector relies on the schema, not on the harness reading every row by hand.** `assertNoDoubleEffect` catches a doubled `shop_workflow_run` or a doubled `shop.staff.notify`, but a doubled `shop_handler_log` write for one envelope and handler is caught differently: `shop_handler_log_once_idx`'s unique index turns that into a failed run on the engine side before a second row can ever appear, and `assertNoFailedRun` is what actually sees it. If that index were ever dropped, a genuine double write there would no longer surface as a failure this harness catches.
- **`tenant-load`'s run-outcome check samples, not reads every envelope, at report size.** 5,000 per-envelope engine reads, even batched at a concurrency of 20, is too slow to be worth it; the check samples 200 envelope ids spread evenly across the run and says so in its own observation (`runOutcomeSampleSize` / `runOutcomeSampledOfTotal`). The doubled/lost-effect checks stay exhaustive — they are plain SQL over the shop's own tables, not engine reads.
- **This harness is never run by CI.** It is a hand-run proof, not a regression gate. A future run against a different engine version, a different machine, or a different Docker memory ceiling would produce different numbers, especially for `tenant-load` and `outbox-backlog`.
