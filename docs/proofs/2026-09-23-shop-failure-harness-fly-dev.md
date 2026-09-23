# Proof: the shop's failure harness against the deployed dev engine (issue #162)

What this is: a written record of `engine-outage`, `outbox-backlog` and `tenant-load` run at
report size against the Kyu engine deployed to Fly (`<engine-app>`, dev), compared against the
same scenarios run on a laptop against the local engine (`docs/proofs/2026-09-22-shop-failure-harness.md`).

**This page is written in two passes.** The section below — what this run does not prove — is
written and committed before any Fly command runs, so the limits of the proof are fixed ahead of
the result, not shaped to fit it afterward. Every other section is filled in from the actual run
in the pull request's second commit.

## What this run does not prove

- **The engine process itself never died.** The `engine-outage` scenario cuts a harness-owned TCP
  proxy between the client and the engine; the engine keeps running and keeps its state the whole
  time. Nothing here shows what happens to in-flight runs when the engine process itself restarts,
  loses its database connection, or comes back with a cold queue. The laptop run did not show that
  either, so this is not a regression from that proof — it is the same gap, now at a larger scale.
  A genuine engine restart needs the CTO to run `fly machine stop` / `fly machine start`; whether
  that happened is recorded in § Engine outage against Fly below, and if it did not, this stays an
  open gap.
- **The shop, its database, the relay and the harness itself all run on a laptop in New Zealand.**
  Only the engine and its Postgres cluster are on Fly, in `syd`. These are not production numbers
  for a deployed consumer of the bus, whose relay and worker would themselves run closer to (or
  further from) the engine than this laptop does.
- **One machine, one region, no autostop.** Nothing here says anything about failover, running more
  than one machine, or a cold start after `autostop`/`autostart`, because dev runs neither.
- **The database is the Basic plan, 10 GB.** Not a production plan or size.
- **Seven of the ten scenarios in the laptop proof were not re-run against Fly** — only
  `engine-outage`, `outbox-backlog` and `tenant-load`. The other seven (the four crash scenarios,
  `long-delay-handoff`, the two cancel scenarios) stand unconfirmed on this deployment; their
  laptop results are the only record that exists for them.
- **The harness is never run by CI**, on the laptop or against Fly. None of this is a regression
  gate; it is a point-in-time measurement.
- **A different day, a different machine size, or a busier Fly edge would give different numbers.**
  The measured round trip and the scenario timings below hold for this one run, not as a standing
  guarantee.

## How this was produced

```bash
fly deploy -c infra/hatchet/fly/fly.toml -a <engine-app>
export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/fly/token.sh -a <engine-app>)"
export HATCHET_CLIENT_API_URL=https://<engine-app>.fly.dev
export HATCHET_CLIENT_HOST_PORT=<engine-app>.fly.dev:7077
export HATCHET_CLIENT_TLS_SERVER_NAME=<engine-app>.fly.dev
unset HATCHET_CLIENT_TLS_STRATEGY
export KYU_SHOP_NAMESPACE=fly162_
export KYU_SHOP_SLOTS=50 KYU_SHOP_DURABLE_SLOTS=200 KYU_SHOP_WATCH_TIMEOUT=1s
export KYU_SHOP_DATABASE_URL=postgresql://hatchet:hatchet@localhost:15432/kyu_shop_fly162
pnpm --filter @kyuworks/shop harness --scenario engine-outage  --size report --out docs/proofs/data/report-162b-engine-outage.json
pnpm --filter @kyuworks/shop harness --scenario outbox-backlog --size report --out docs/proofs/data/report-162b-outbox-backlog.json
pnpm --filter @kyuworks/shop harness --scenario tenant-load    --size report --out docs/proofs/data/report-162b-tenant-load.json
```

- Commit: each run JSON's own `commitSha` reads `caa4dc155b382e08ba44062effdbeb7bc0ccb620-dirty` — the
  working tree at run time, one commit past this branch's first (`caa4dc1`), dirty with the
  `fly.toml` gRPC-port fix (found on first deploy, below) and the `LANE_TABLES` fix (also below),
  both since committed to this branch.
- Deployment: app `<engine-app>`, org `<fly-org>`, region `syd`, machine size `performance-1x`,
  one machine, no autostop, image `ghcr.io/hatchet-dev/hatchet/hatchet-lite:v0.107.0` (the harness's
  own `engineVersion` field reads `hatchet-lite:latest` — the same fallback the laptop proof used,
  since `/api/v1/meta` carries no version field on this engine either), database Fly Managed
  Postgres `<engine-db>`, plan Basic, Postgres 17, 10 GB, `syd`, session-mode direct
  connection. The committed JSONs' `engineVersion` field predates this pull request's fix to
  `report.ts`'s `composeImageTag()`, which now reads the pinned tag from
  `infra/hatchet/compose.yaml` instead of defaulting to `latest`; the real version run here was
  v0.107.0, as stated above.
- Lane database (local, not on Fly): `kyu_shop_fly162` on
  `postgresql://hatchet:hatchet@localhost:15432/kyu_shop_fly162`.
- **Two fixes made during this deploy, both recorded in this pull request:**
  1. `infra/hatchet/fly/fly.toml`'s gRPC port (7077) needed `handlers = ['tls', 'http']` plus
     `http_options.h2_backend = true`, not the bare `handlers = ['tls']` PR A shipped. A bare `tls`
     handler on a `*.fly.dev` hostname never offers an ALPN protocol at all (confirmed directly
     with `openssl s_client -alpn h2`: "no application protocol"), so grpc-js's mandatory ALPN
     negotiation failed before the handshake completed — `SERVER_GRPC_INSECURE` was never the
     issue (assumption check 2 in the plan named the wrong suspect). Adding `tls_options.alpn`
     to the bare `tls` handler, the fix the Fly community docs suggest for a custom domain, made no
     difference on `*.fly.dev`; adding `http` fixed ALPN but then had Fly forward to the backend as
     HTTP/1.1, which a raw gRPC (h2c) server cannot parse (`hyper error: invalid HTTP version
     parsed`); `http_options.h2_backend = true` is what makes Fly forward HTTP/2 to the backend
     instead.
  2. `examples/shop/src/__tests__/harness/scenario.ts`'s `LANE_TABLES` was missing
     `shop_lead_projection` (added in migration `0007_shop.sql`), even though the comment claimed
     it mirrors `vitest.integration.clearTables.ts`'s `CLEAN_TABLES`, which already had it. The very
     first harness run against this freshly migrated database failed
     `harness-leaves-nothing: truncating lane tables failed: cannot truncate a table referenced in
     a foreign key constraint` — `shop_lead_projection` references `shop_order` but was never
     truncated with it. This is not Fly-specific; it would have failed identically against a fresh
     local database.

## The network path

The harness, the relay, the worker, the shop's Postgres and the outbox all run on this laptop in
New Zealand; only the engine and its database are in Sydney (`syd`). Every scenario number below
crosses that link once per engine call, where the laptop proof's numbers crossed loopback.

Measured round trip (`curl -w '%{time_total}' -o /dev/null -s https://<engine-app>.fly.dev/api/ready`,
ten samples, seconds): 0.148, 0.141, 0.199, 0.141, 0.142, 0.144, 0.144, 0.142, 0.140, 0.143.
Min 140ms, median 143ms, max 199ms.

## Results table

| Scenario | Result | Wall time on Fly | Wall time on the laptop | Ratio |
|---|---|---|---|---|
| `engine-outage` | PASS | 61,046ms | 103.5s (103,500ms) | 0.59x (faster) |
| `outbox-backlog` | **FAIL** (missed its 5-minute window) | 301,762ms | 50,221ms (996 rows/sec) | 6.0x |
| `tenant-load` | **FAIL** (missed the durable-wait window; the 20-minute plain window was met) | 1,813,911ms (30.2 min) | 221,426ms (3.7 min, 50/200 slots) | 8.2x |

`engine-outage`'s first attempt (122,083ms) is not counted in this table — its `--out` path was
relative and resolved against the wrong working directory (`pnpm --filter` runs from
`examples/shop`, not the repo root), so the JSON never wrote. The scenario itself passed both
times; the number above is the second, correctly recorded run. `engine-outage` running faster
against Fly than the laptop is plausible, not suspicious: its wall time is dominated by the fixed
5-second hold-open and the assertion polling intervals, not by round-trip count, so a single-digit
number of extra round trips at ~140ms each does not move it much either way.

## Throughput

`outbox-backlog` inserts 50,000 outbox rows with the relay stopped, then starts the relay alone and
times the drain. It failed its 5-minute (300,000ms) window at report size: after 301,762ms, 1,201 of
50,000 rows (2.4%) were still pending. Rows drained in that time: 48,799, for roughly **162
rows/sec** — against the laptop's 996 rows/sec, about **6x slower**. This is the scenario the plan
expected the WAN link to hurt most, because the relay's push is one round trip per batch: at ~140ms
per round trip, the extra latency directly taxes every batch, where on loopback that same round
trip cost close to nothing.

`tenant-load` missed its durable-wait window (below) — the 20-minute plain-handler window was met
— and its six-entry failure list is short: 2 of 5,000 orders' `watch-shipping` handlers never ran
at all, 3 runs were still in flight at teardown, and the scenario's own aggregate line records that
not every order's `watch-shipping` run reached a terminal row in time. So the exact
handler-rows/sec and orders/sec figures the laptop proof reports are not available for this run:
`runScenario`'s teardown truncates the lane tables in a `finally` block regardless of pass or fail,
and by the time this was checked those rows were already gone. Precise Fly-side throughput numbers
for `tenant-load` are not in this proof; the wall-time comparison and the failure count above are
what is available.

### tenant-load — FAILED at report size

What was injected: 20 tenants (one large, nineteen small) publishing 5,000 orders at once, against a
worker sized `KYU_SHOP_SLOTS=50` / `KYU_SHOP_DURABLE_SLOTS=200` — the same slot counts as the
laptop proof's third, passing run. This scenario waits for the three plain handlers
(`record-order`, `audit-order`, `send-invoice`) within a 20-minute window, then separately waits for
every order's durable `watch-shipping` run to reach a terminal row within a 15-minute window.

What was observed: the run took 1,813,911ms (30.2 minutes) in total. The plain-handler wait
(`record-order`, `audit-order`, `send-invoice` within the 20-minute window) completed in time — the
committed JSON carries no entry for a missed plain window, the entry `tenantLoad.ts` pushes only
when that wait times out — but the durable wait (every order's `watch-shipping` run reaching a
terminal row within the 15-minute window) did not: it ran the full 900,000ms and still failed. Six
failure entries resulted: three runs still `running` when teardown tried to confirm nothing was
left unsettled (one `record-order`, two `watch-shipping`), two orders whose `watch-shipping:timeout`
handler never ran at all, and the scenario's own aggregate line, `watch-shipping never reached a
terminal row for 5000 orders within 900000ms` — against 5,000 orders each expected to produce four
handler rows, this is a small tail, not a bulk loss. **This is not a delivery-guarantee failure** —
nothing here shows a doubled effect or a lost outbox row, the same must-hold checks the plan
requires held for everything that did settle. What failed is finishing the durable wait inside its
time budget at this scale, over this link.

The relay/worker logs show `HeartbeatController` warnings spread across nearly the whole run
(01:24–01:49, 26 occurrences) and a cluster of `Dispatcher`/`HeartbeatController` errors
concentrated early, roughly 01:28–01:34 (about six minutes), then nothing until teardown. That
shape — a rough patch early, then quiet — points at engine-side queueing under load rather than a
sustained connectivity problem, matching the plan's own prediction that `tenant-load`'s cost is
engine-side queueing rather than per-round-trip latency (unlike `outbox-backlog`, whose relay pushes
one round trip per batch). Exact throughput numbers are not available (see § Throughput) because
teardown truncated the lane tables before this was checked.

**The issue's window is not being widened to make this pass.** This scenario was run once, at the
same 5,000-order size, the same slot counts, and the same 20-minute / 15-minute windows the laptop
proof used, and it took roughly 8x longer before missing the durable-wait window (the plain-handler
window was met). That ratio, and the small, specific failure list above, is the honest result of
running it against a real WAN link rather than loopback.

**Cleanup gap:** at the second teardown check, 9 `watch-shipping` runs were still queued under this
scenario's namespace even though the first check had already reported the namespace empty — the
engine requeued a retry after that check ran. Nothing here was cancelled; the gap is tracked as
issue #165.

Changed in #165: `cancelLeftoverRuns` now settles only after the namespace has stayed empty for 60
seconds, reissuing the cancel on every poll. On 2026-09-23 the namespace held 0 run(s) (the
leftovers had already ended by themselves); after the cancel it held 0.

### outbox-backlog — FAILED at report size

What was injected: 50,000 outbox rows inserted directly (the relay stopped), then the relay started
alone and the drain sampled once a second — no worker involved, so this isolates the relay's own
push throughput against the deployed engine's REST push endpoint.

What was observed: at 301,762ms (5.03 minutes), 1,201 of 50,000 rows (2.4%) were still pending, past
the 5-minute (300,000ms) window this scenario allows. This is not a delivery-guarantee failure:
nothing here contradicts must-hold — every row that failed to settle in time was still sitting in
the outbox, not lost, not doubled, and would have drained had the window been longer. What failed is
throughput at this latency: roughly 162 rows/sec against the laptop's 996 rows/sec, a 6x slowdown,
consistent with the relay pushing one batch per round trip and each round trip now costing ~140ms
instead of loopback's near-zero cost.

**The issue's window is not being widened to make this pass.** This scenario was run once, at the
same 50,000-row size and 5-minute window the laptop proof used, and it missed the window by 1,762ms
— under 1% over. That margin, and the throughput math above, is the honest result of running it
against a real WAN link rather than loopback.

The committed `report-162b-outbox-backlog.json`'s `failures` array is capped at the first 20 of the
1,201 real entries (`failuresCappedForReview: { shown: 20, total: 1201 }`), so the file stays
reviewable — every prior scenario's report committed under `docs/proofs/data/` came from a passing
run with a near-empty failures array, and this is the first one to hit `check-pr-size.sh`'s limit on
data alone. The 20 shown are representative: every one reads `outbox-settled: outbox row <id> is
still pending`, the same shape as the other 1,181.

## Engine outage against Fly

The harness's own proxy (`proxy.ts`'s `engineProxyTargetFromEnv`, this pull request's code change)
cut a TCP proxy in front of `<engine-app>.fly.dev:7077` and `https://<engine-app>.fly.dev`,
confirmed by the run's own recorded `proxyTargetHost: "<engine-app>.fly.dev"` — not localhost,
which is exactly the bug this pull request fixes. 20 orders were placed and settled before the cut,
20 more during the cut; the relay logged an error and a pending backlog was observed
(`sawRelayError: true`, `backlogObserved: true`), it stayed alive through the cut and to the end
(`relayStayedAliveDuringCut: true`, `relayAliveAtEnd: true`), the worker stayed alive too
(`workerAliveAtEnd: true`), the outbox drained in 19,616ms after reopening, and all 40 order-placed
envelopes' expected effects settled in time (`effectsSettledInTime: true`, `handlerRowCount: 120`).

This proves the same thing the laptop run proved — the relay observes the loss, backs off, stays
alive, loses nothing, doubles nothing — now over a real WAN path with real TLS through the Fly edge,
not loopback.

**What it does not prove, same as stated up front:** the engine process itself never died — only
the client's path to it was cut. No CTO-run `fly machine stop` / `fly machine start` rehearsal was
part of this pull request's session, so the engine-restart case (in-flight runs across a real engine
restart, a lost database connection, a cold queue) stays unproven on this deployment, exactly as the
laptop proof also left it unproven. This is recorded here rather than silently dropped.

## Restore rehearsal

Source backup `20260922-121422F_20260922-130302I` (incremental, completed `2026-09-22T13:03:02Z`),
restored into a new throwaway cluster `<engine-db>-restoretest` (id `<restore-test-cluster-id>`),
region `syd`, plan Basic. The restore command returned immediately; the cluster read `creating`
until it reached `ready`, about 3.5 minutes later. The source cluster `<engine-db>` was
confirmed untouched and still `ready` throughout, on both sides of the restore.

**Not completed in this pull request's session:** connecting to the restored cluster to check its
contents needs the CTO (only the CTO reads a Fly connection string). The three numbers the plan
asks for — `\dt` listing Hatchet's own tables, the tenant table's row count, the task table's row
count — were not collected, so this restore is proven to *complete* but not yet proven to hold
readable, correct data. `<engine-db>-restoretest` is left running rather than destroyed,
because the plan gates destruction on that CTO verification and this session could not get it
synchronously; see `docs/operations/kyu-engine-on-fly.md`'s Restore log for the exact follow-up
(CTO connects and reports the three numbers, then the cluster is destroyed and the runbook and this
page are updated). This step, the admin-login check, and the token-survives-a-restart check are
tracked as issue #165, so nothing here is lost when this pull request merges.

**Update (issue #173).** The CTO destroyed `<engine-db>-restoretest` on 2026-09-23 without
reading its data. The three-number check was skipped. The restore is proven to complete, not
proven to hold readable data.

## In-region run (issue #166)

What this is: `tenant-load` and `outbox-backlog` — the two scenarios that missed their windows
when the relay, worker and harness ran on a laptop against the deployed engine, above — run again
from inside `syd`, beside `<engine-app>`, in a separate Fly app (`<shop-harness-app>`) built
from `infra/shop-harness/fly/`.

**This section is written in two passes, the same as the page's first section.** What this run
does not prove, immediately below, is written and committed before any in-region command runs;
its wording was lightly revised for clarity after the run, in this pull request's tidy-up commit,
without changing what it claims. The comparison table and the per-scenario results are filled in
from the actual run in this pull request.

### What this run does not prove

- **The engine process never died.** `engine-outage` was not run in-region; #166 keeps it a
  client-side cut against a deployed engine, out of scope for this issue.
- **It is one run on one day.** Other days, sizes, or a busier Fly edge give other numbers.
- **Both clusters are Basic plan, 10 GB.** The shop database sits on its own second Basic cluster
  (`<shop-harness-db>`), not the engine's own Basic-plan cluster (`<engine-db>`), and
  neither is a production-sized plan.
- **The harness, the relay and the worker share one `performance-2x` machine.** A real consumer
  would run the relay and its workers as separate machines. The harness machine
  (`performance-2x`, 2 dedicated vCPU, 4 GB) is larger than the engine's own machine
  (`performance-1x`, 1 dedicated vCPU, 2 GB).
- **The path is the engine's internal 6PN address with TLS off**, or the public edge if the
  fallback in `docs/operations/kyu-engine-on-fly.md` was used — stated below either way. It says
  nothing about a consumer outside org `<fly-org>`.
- **Only `tenant-load` and `outbox-backlog` ran in-region.** The other eight scenarios stand on
  their laptop and laptop-to-Fly results only; none of them were re-run here.
- **The rolled-back-transaction must-hold row is not exercised by either scenario.** Neither
  `tenant-load` nor `outbox-backlog` publishes inside a transaction that then rolls back.
- **The #165 teardown-requeue gap was fixed after this run.** This run used the old one-read
  teardown. Cancelling afterwards, with the new command, found 0 runs under the laptop-to-Fly
  namespace (`fly162_tenant_load_2072de_` — it had already ended by the schedule timeout) and 18
  under the in-region namespace (`inregion166_tenant_load_593c3d_`), and left all 18 in place (see
  below).
- **CI never runs the harness**, in-region or otherwise. This is a point-in-time measurement, not
  a regression gate.

### How this was produced

```bash
fly apps create <shop-harness-app> -o <fly-org>
fly mpg create -o <fly-org> -n <shop-harness-db> -r syd --plan Basic --pg-major-version 17 --volume-size 10 >/dev/null
fly config validate -c infra/shop-harness/fly/fly.toml -a <shop-harness-app> --strict
fly deploy . -c infra/shop-harness/fly/fly.toml --dockerfile infra/shop-harness/fly/Dockerfile \
  --ignorefile infra/shop-harness/fly/harness.dockerignore \
  --build-arg KYU_HARNESS_COMMIT_SHA="$(git rev-parse HEAD)" --ha=false -a <shop-harness-app>
fly machine start <machine-id> -a <shop-harness-app>
bash infra/shop-harness/fly/collect.sh -a <shop-harness-app> -m <machine-id> -s tenant-load -o docs/proofs/data/report-166-tenant-load.json
bash infra/shop-harness/fly/collect.sh -a <shop-harness-app> -m <machine-id> -s outbox-backlog -o docs/proofs/data/report-166-outbox-backlog.json
fly machine stop <machine-id> -a <shop-harness-app>
```

- App `<shop-harness-app>`, machine `<shop-harness-machine-id>`, `performance-2x`, `syd`, image built on Fly's
  remote builder from `infra/shop-harness/fly/Dockerfile`. Database cluster
  `<shop-harness-db>` (id `<shop-cluster-id>`), Basic, Postgres 17, 10 GB, `syd`, database
  `kyu_shop_inregion`.
- Network path used: the engine's internal 6PN address, plaintext — `HATCHET_CLIENT_HOST_PORT =
  '<engine-app>.internal:7077'`, `HATCHET_CLIENT_API_URL = 'http://<engine-app>.internal:8888'`,
  `HATCHET_CLIENT_TLS_STRATEGY = 'none'`. The preflight (`GET /api/ready`) answered 200 on every
  attempt and every scenario ran to completion over this path — **the public-edge fallback was
  never needed.**
- **A `fly deploy` alone does not start a run on this app.** With no service block and `[[restart]]
  policy = 'never'`, a deploy that only updates an already-stopped machine's config leaves it
  `stopped`. `fly machine start <id>` is the step that actually executes `run.sh`; see
  `docs/operations/kyu-engine-on-fly.md`'s "Running the shop harness in-region" section, which
  states this explicitly.
- Commit: each collected report's `commitSha` reads `9c9ae54c2d31ab90db8f9f5435821a6e8c20e25d` —
  the migrate database-name logging change, kept in for this run, baked in at image build time
  from the `KYU_HARNESS_COMMIT_SHA` build argument above. A build argument cannot detect an
  unstaged change, so unlike the laptop-to-Fly run's git-derived `-dirty` suffix (§ How this was
  produced, above), this `commitSha` never carries `-dirty`, and a clean tree at build time is not
  proven by it. `engineVersion` reads `hatchet-lite:v0.107.0` — that field is read from the pinned
  tag in `infra/hatchet/compose.yaml`, not from the deployed engine itself; the laptop-to-Fly run's
  JSON reads `hatchet-lite:latest` because that run predates the fix to `composeImageTag()` noted
  above, while the actual deployed engine version, confirmed separately with `fly machine list`,
  is v0.107.0 in both runs.

**Two blockers hit before either scenario could run, both recorded here rather than worked around
silently:**

1. **The harness cluster's app role cannot `CREATE DATABASE`.** `ensureDatabase`
   (`examples/shop/src/db/migrate.ts`) connects to `/postgres` and issues `CREATE DATABASE` when a
   lookup finds no matching row; the plain fact is that on a fresh Managed Postgres cluster the app
   role lacks the `CREATEDB` privilege. Fixed by creating the database through the platform, once,
   with no secret involved: `fly mpg databases create <shop-cluster-id> -n kyu_shop_inregion`.
2. **The first `KYU_SHOP_DATABASE_URL` staged on the app named the engine's cluster
   (`<engine-db>`), not the harness's own one, even though the database name in the string
   was already correct.** This was found without reading the secret, by logging the target
   database name only (`migrateLogFields()`, `examples/shop/src/db/migrate.ts` and
   `examples/shop/src/bin/migrate.ts`), which showed the name was right while the string's host was
   wrong; the CTO re-staged the direct connection string of the correct cluster
   (`<shop-harness-db>`, `<shop-cluster-id>`), and migrate then applied all 10 pending SQL
   files cleanly. The engine's cluster holds only its own `fly-db` database, so the wrong first
   secret left nothing behind there.

### Comparison table

| | Laptop only | Laptop to Fly | In-region | In-region, performance-2x + Starter | In-region, performance-2x + Launch | In-region, performance-2x + Launch + RabbitMQ |
|---|---|---|---|---|---|---|
| Harness, relay, worker run | laptop (NZ) | laptop (NZ) | `<shop-harness-app>`, `syd` | `<shop-harness-app>`, `syd` | `<shop-harness-app>`, `syd` | `<shop-harness-app>`, `syd` |
| Machine size | laptop spec | laptop spec | `performance-2x` (2 dedicated vCPU, 4 GB) | `performance-2x` | `performance-2x` | `performance-2x` |
| Shop database | local Docker Postgres | local Docker Postgres | `<shop-harness-db>`, Basic, `syd` | `<shop-harness-db>`, Starter | `<shop-harness-db>`, Launch | `<shop-harness-db>`, Launch |
| Engine | local compose v0.107.0 | `<engine-app>`, `performance-1x` | same | `<engine-app>` machine `<engine-machine-id>`, `performance-2x`, database Starter | same machine `<engine-machine-id>`, `performance-2x`, database Launch | same machine `<engine-machine-id>`, `performance-2x`, database Launch, internal queue on RabbitMQ (`<rabbitmq-app>`, `performance-1x`) |
| Network path | loopback | NZ→`syd` public edge, TLS, median 143ms | `syd` internal 6PN, plaintext | same | same | same |
| `outbox-backlog` | PASS, 50,221ms, 996 rows/sec | FAIL, 301,762ms, ~162 rows/sec | FAIL, 304,063ms, ~161 rows/sec | FAIL, 367,820ms, ~56 rows/sec adjusted for teardown (run alone, 10:04–10:10Z) | FAIL, 365,169ms, ~162 rows/sec adjusted for teardown; 600 of 50,000 rows left | **PASS**, 111,221ms; drained in 47,431ms; ~976 rows/sec adjusted for teardown (1,054 by the harness's own drain timer) |
| `tenant-load` | PASS, 221,426ms, 50/200 slots | FAIL, 1,813,911ms | FAIL, 2,300,934ms | FAIL, 2,422,223ms; plain window missed; durable window missed | **PASS**, 378,707ms; plain window met at 314,305ms, durable at 314,372ms; ~80 handler rows/sec | **PASS**, 314,404ms; plain window met at 141,525ms, durable at 250,261ms; ~100 handler rows/sec |
| Commit | — | `caa4dc1...-dirty` | `9c9ae54` | `15542eb` | `15542eb` (same image as #173) | `15542eb` (same image as #173) |
| JSON file | `docs/proofs/data/report-155-*.json` | `docs/proofs/data/report-162b-*.json` | `docs/proofs/data/report-166-*.json` | `docs/proofs/data/report-173-*.json` | `docs/proofs/data/report-175-*.json` | `docs/proofs/data/report-176-*.json` |

The last three columns' durations include the 60-second teardown quiet period added by #169; the
#173 tenant-load miss is far larger than that.

**Every duration in the first three columns predates the 60-second quiet period #169 added to
`cancelLeftoverRuns`.** After this change, teardown's cancel loop
(`examples/shop/src/__tests__/harness/scenario.ts` ~311–331) runs inside the same window a
scenario's own wall time is measured against, for every scenario, not only the ones that had
leftovers. A local report-size `tenant-load` run after this change read 423,209ms total, with its
own effects settled at 362,009ms — the gap is teardown's quiet period, not scenario work. A
duration measured after this pull request merges is not comparable to any number in this table, or
in the earlier results table above, without adding that gap back in.

**The in-region numbers are not faster than the laptop-to-Fly run, and `outbox-backlog`'s
throughput is essentially unchanged (~161 vs ~162 rows/sec).** Cutting the network hop did not fix
either miss. For `outbox-backlog` specifically, that result **contradicts** the round-trip-latency
explanation given earlier in this page (§ Throughput, and § `outbox-backlog` — FAILED at report
size, above): the earlier explanation was that the relay's one-round-trip-per-batch push, taxed by
the ~140ms cross-Tasman hop, was the throughput ceiling. Removing that hop in-region should have
sped the drain up under that explanation; it did not, so round-trip latency is not what is
capping this scenario's throughput.

The harness app's worker and relay logs (not the engine's own logs, which this harness has no
access to) show recurring `HeartbeatController` and `Dispatcher` errors during the run (`Failed to
send heartbeat: ... invalid auth token`, `/EventsService/BulkPush INTERNAL: An internal error
occurred`, `/Dispatcher/SendStepActionEvent INTERNAL`), the same messages the laptop-to-Fly proof
saw and attributed to engine-side queueing under load. The `invalid auth token` line plainly points
at an authentication problem with that heartbeat call, not at capacity, and is not used here as
capacity evidence. These quoted lines could not be re-read afterward to confirm exact counts or
timestamps: Fly's log retention for this app is the last 100 lines only. **The issue's windows are
not widened and the scenario's size is not shrunk to make either pass** — both ran once, at the
same 5,000-order / 50,000-row sizes and the same windows every other run in this page used.

**Follow-up (#165).** A smoke-size in-region `tenant-load` on 2026-09-23 with the same token logged
0 `invalid auth token` lines and passed. That shows only that the token was accepted at smoke size
that day — it does not show why the report-size run above logged the line. Engine-side token
validation under load is an open hypothesis, not a confirmed cause. The token's measured lifetime
(`exp` minus `iat`) is 90 days on v0.107.0, matching the admin tool's own default of 2160h; the
engine had not restarted since 2026-09-22T13:10Z as of this section (issue #166) — it restarted
again on 2026-09-23, see "Engine one size up (issue #173)" below. Whether to re-mint before the 90
days are up is
the CTO's decision.

### Per-scenario results

#### `outbox-backlog` — FAILED at report size

50,000 outbox rows were inserted with the relay stopped, then the relay started alone and the
drain sampled once a second, the same as every other run of this scenario. At 304,063ms (5.07
minutes), 901 of 50,000 rows (1.8%) were still pending, past the 5-minute (300,000ms) window — a
narrower miss than the laptop-to-Fly run's 2.4% (1,201 rows), but still a miss. Rows drained:
49,099, for roughly **161 rows/sec**, essentially identical to the laptop-to-Fly run's ~162
rows/sec and nowhere close to the laptop-only run's 996 rows/sec. Nothing here contradicts
must-hold: every pending row was still sitting in the outbox, not lost, not doubled, and would have
drained given more time. The committed JSON's `failures` array is capped at the first 20 of the
901 real entries (`failuresCappedForReview: { shown: 20, total: 901 }`), the same `#164` pattern;
all 20 shown, and a spot check of the full set, read `outbox-settled: outbox row <id> is still
pending`. The full, uncapped report on the machine was about 128 KB; the committed, capped file is
about 3.3 KB.

#### `tenant-load` — FAILED at report size

20 tenants (one large, nineteen small) published 5,000 orders at once, against a worker sized
`KYU_SHOP_SLOTS=50` / `KYU_SHOP_DURABLE_SLOTS=200`, the same as every other run of this scenario.
Total wall time: 2,300,934ms (38.3 minutes) — longer than both the laptop-only run (3.7 minutes)
and the laptop-to-Fly run (30.2 minutes). The committed JSON carries no entry for a missed
plain-handler window (`tenantLoad.ts` only pushes one when that wait itself times out), so the
20-minute plain-handler wait (`record-order`, `audit-order`, `send-invoice`) was met, the same as
both earlier runs; the 15-minute (900,000ms) durable-wait window for every order's `watch-shipping`
run was not. 17 failure entries resulted: 8 runs still `running` at teardown (5 `record-order`, 3
`watch-shipping`), 7 individual orders whose `watch-shipping:timeout` handler never ran, the
scenario's own aggregate line (`watch-shipping never reached a terminal row for 5000 orders within
900000ms`), and one `harness-leaves-nothing` entry: the engine still held 19 queued or running runs
in namespace `inregion166_tenant_load_593c3d_` after teardown. On 2026-09-23,
`cancelNamespaceCli.js` found 18 of them still queued or running and left 18 (issue #165).

**These 18 are strongly indicated, not proven, to be stale rows in the engine's REST run list,
not genuinely stuck work.** On the local engine, a parallel check found 294 similar day-old
leftovers listed as RUNNING or QUEUED while the engine's own tables (`v1_task_runtime`,
`v1_queue_item`, `v1_retry_queue_item`) held none of them: 99 carried a COMPLETED event and the
gRPC run detail agreed COMPLETED, and the rest carried only `SIGNAL_COMPLETED`. Cancelling a
completed run by id returns the id and sets the core status CANCELLED, but the list still shows
COMPLETED afterwards. So `unsettledInNamespace` and `harness-leaves-nothing` are reading stale
list state for a run in this shape, and no cancel — the new command included — can clear it. This
explanation is strongly indicated, not proven, for the 18 on Fly specifically, because the Fly
engine's own database was not read in this session. Either way, `cancelNamespaceCli.js` cannot be
relied on to bring this namespace's count to 0, and `harness-leaves-nothing` will keep reporting
these runs for as long as the engine's list keeps showing them. Against 5,000 orders each expected to
produce four handler rows, this is a small tail — unlike the laptop-only run, which had zero
failures; only the laptop-to-Fly run showed a comparable tail. The harness's `no-effect-lost` check
failed for the 7 orders above plus the aggregate line, so those effects were not seen within the
window and whether they ever ran at all is unknown; the outbox rows themselves were not lost.

**Reading the two results together:** neither scenario got faster or more accurate by moving the
harness, the relay and the worker into `syd`. That rules out the cross-Tasman network hop as the
sole or even primary cause of the laptop-to-Fly misses; the engine's own queueing under this load
size, on a `performance-1x` machine (issue #173, below, tested one size up), is the more likely ceiling, consistent with the
`HeartbeatController`/`Dispatcher` error pattern logged during this run. A larger engine machine or
a smaller load size were not tried here — #166 asked only for the in-region measurement, not a
capacity fix.

## Engine one size up (issue #173)

What this is: the same `tenant-load` and `outbox-backlog` scenarios from the in-region run above,
run again with the dev engine machine resized from `performance-1x` to `performance-2x`, to tell
apart the two explanations issue #166 left open — the engine machine's size, or its token
validation under load.

### What this run does not prove

- **Two things changed at once.** The engine machine went `performance-1x` → `performance-2x` and
  both database clusters went Basic → Starter, because both changes landed the same day; this run
  cannot separate their effects.
- **One run.** Not repeated, not averaged.
- **No CPU or database metrics were read.** Nothing here is measured against the machine's or the
  cluster's own resource graphs.
- **`outbox-backlog` ran alone, in a later start, not in the same run as `tenant-load`.** The first
  attempt's report could not be collected (below); this page's `outbox-backlog` numbers come from a
  separate recovery run against the same resized engine, starting 27 minutes after `tenant-load`
  finished. Whether that run left anything queued on the engine was not checked before the
  recovery run started.
- **The Starter plan's CPU kind was not checked.** Whether Starter is shared or dedicated CPU was
  not confirmed for this run.
- **The report run started about 2 minutes after the cloned engine machine came up** (machine
  created 08:54:12Z, run started 08:56:28Z), inside the "wait 10 minutes, or run a smoke-size
  harness run" guidance this pull request adds to the runbook after a restart. No smoke-size run
  against the cloned machine specifically was recorded before this report-size run.

### What was done

The CTO restarted engine machine `<old-engine-machine-id>` at 06:53:50Z. Two smoke-size `tenant-load` runs
followed with the existing worker token: the first (`report-173-smoke-after-restart-failed.json`)
failed with `runs.forEnvelope … Request failed with status code 500` after 3 attempts, 92,269ms; the
second (`report-173-smoke-after-restart.json`), about 8 minutes after the restart, passed — 200
orders, 1,000 handler rows, 108,790ms. `fly machine update --vm-size performance-2x` was refused
twice with "insufficient memory available to fulfill request on the current host"; the engine was
resized instead by forking its config volume and cloning the machine (`docs/operations/kyu-engine-on-fly.md`,
"Resizing the engine machine"). The two engine machines ran against one cluster for about 70
seconds during that clone; the cluster refused connections for part of that window (Engine log,
below). The report run started 08:56:28Z from commit `15542eb`, namespace `inregion173_`.

### `tenant-load`

FAIL, 2,422,223ms. 11,434 failures: 1,897 orders × 4 `no-effect-lost` "never ran" rows
(`record-order`, `audit-order`, `send-invoice`, `watch-shipping:timeout`), 3,844 `outbox-settled`
"still pending", plus two aggregate lines — `expected handler effects for 5000 orders never settled
within 1200000ms` (the plain window, missed for the first time on this page) and `watch-shipping
never reached a terminal row for 5000 orders within 900000ms` (the durable window, also missed).

No message the engine accepted was lost. Every one of the 3,794 envelopes whose handlers never ran
still had its outbox row pending at the deadline: the relay had not handed them to the engine yet.
This is the first run on this page where the plain window was missed. 50 further pending outbox
rows had no missing handler row.

Stored copy capped `{ shown: 22, total: 11434 }` (first 20 failures plus both aggregate lines, the
`#164` pattern). Full report: 1,827,215 bytes, sha256 `e16c0d6da834ce63aa42021c7b72dc485cfb011dcb2d54b8138c7f341f07c71d`.

### `outbox-backlog`

The first attempt's report was not recovered: `collect.sh` read the whole file in one
`fly machine exec`, which has a response-size limit somewhere between about 1.8 MB and the report's
6,772,068 bytes; the read failed with "could not read /reports/outbox-backlog.json from machine",
and the machine was stopped in the same command, so nothing was left to retry against. That first
attempt itself FAILED, at 365,979ms.

**Recovery run.** A separate, `outbox-backlog`-only run against the same resized engine, namespace
`inregion173b_`: the harness machine started 10:03:57Z, `preflight-ok` and `migrate-done` both at
10:04Z, and `scenario-done scenario=outbox-backlog` at 10:10:09Z — FAIL, 367,820ms. 50,000 outbox
rows were inserted with the relay stopped; at the 300,000ms (5-minute) window, 32,700 of 50,000
rows (65.4%) were still pending — a far larger miss than the earlier in-region run's 901 rows
(1.8%, issue #166) or the laptop-to-Fly run's 1,201 (2.4%). Rows drained: 17,300. The scenario's
367,820ms total includes the 60-second quiet period #169 added (§ Comparison table, above),
which is not part of the drain; over the remaining ~307,820ms
that is roughly **56 rows/sec**, well below every earlier run of this scenario on this page
(161–996 rows/sec). Nothing here contradicts must-hold: every pending row was still sitting in the
outbox, not lost, not doubled. Report: 4,742,068 bytes, sha256
`617f0b23d325cc823ece46c5f760a1f2014d6251e03012cb04af5e63369aaa71`, collected in 5 parts with the
`collect.sh` fix from this pull request. Stored copy capped `{ shown: 21, total: 32701 }` (20
individual failures plus the one aggregate line, the `#164` pattern).

### Engine log

Machine `<engine-machine-id>`, lines at or after 08:56:28Z (the `tenant-load` run's start) through
09:43:48Z (end of tail), counted by `grep`/`awk` on the raw log: 69,784 lines in the window; 809
`failed to send callback completed message to dispatcher`; 654 `error adding message for queue`;
417 `error binding queue`; 93 `error replenishing slots`; 3,476 `queue took longer than 100ms`;
20,778 `long transaction` (3,140 in `optimistic_tx.go`, 3,238 in `durable_events.go`, 6,620 in
`olap.go`); 3,611 `context deadline exceeded`. Connection-slot errors (`remaining connection slots
are reserved`, `too many clients`): 7 lines at 09:33:08–10Z, with only one engine machine
running — during the `tenant-load` run itself; 11 more at 08:54:38Z, while both engine machines ran
against the cluster during the clone.

### Harness log

1 `invalid auth token` line, at 09:33:48Z; 104 heartbeat lines after 08:56Z. Captured with a live
`fly logs` tail saved to a file during the run, not read back afterward — the app's log retention
is the last 100 lines only (§ In-region run, above).

### What this supports

Neither explanation in issue #173 holds as stated. The larger engine machine, together with the
Starter database plan (the two changed at once — see "What this run does not prove"), did not
help: `tenant-load` did worse than the earlier in-region run on `performance-1x`, and the recovered
`outbox-backlog` run drained rows at roughly a third the earlier in-region run's rate (~56 vs ~161
rows/sec) and an order of magnitude below the laptop-only run's 996. Token validation does not
explain it: one `invalid auth token` line in a 40-minute run with 11,434 failures. The engine log
points at its Postgres-backed internal message queue on the managed database: timed-out queue
writes, dispatcher callbacks and long transactions, and the cluster ran out of connection slots
under this load. Because the database plan changed at the same time as the machine size, this run
cannot say whether Starter is worse than Basic, or whether a larger machine alone would have done
better; neither combination did. The variable most likely left is the database plan — whether
Starter gives dedicated CPU was not checked here (see "What this run does not prove"). The design
document's scaling path (§ 12: separate engine replicas with RabbitMQ) is the other. The CTO
decides whether to run either.

## Both databases on the Launch plan (issue #175)

What this is: the same `tenant-load` and `outbox-backlog` runs as issue #173, on the same engine
machine (`<engine-machine-id>`, `performance-2x`) and the same harness image, after the CTO moved both
managed Postgres clusters from Starter to Launch, a plan with dedicated CPU: the engine's
`<engine-db>` (`<engine-cluster-id>`) and the harness's `<shop-harness-db>`
(`<shop-cluster-id>`). Only the database plan changed since #173.

### What this run does not prove

- **This list was written after the run**, unlike the earlier sections on this page.
- **Both clusters changed at once.** The engine's database and the shop's database both moved to
  Launch, so this run cannot say which of the two mattered. The engine log (below) suggests only
  that the engine's side is involved; it does not rule out the shop's cluster.
- **One run.** Not repeated, not averaged.
- **No CPU or database metrics were read.** That Launch gives dedicated CPU is the plan's own
  description, not something measured here.
- **The engine and harness logs are live tails saved during the run.** Whether a tail kept every
  line was not checked.
- **`engine-outage` and the other seven scenarios were not re-run.**

### What was done

A smoke-size `tenant-load` ran first, at 10:47:45Z (`harness-tail-175.log`'s `scenario-done` line
gives `ts=10:49:09.155Z` and `durationMs=83746`, so start is 10:47:45.409Z; the `migrate-done` line
immediately before reads 10:47:45.005Z), namespace `inregion175s_`: PASS, 83,746ms
(plain 18,762ms, durable 18,768ms), 200 orders, no failures (`report-175-smoke.json`). The
report-size run started at 10:54:22Z, namespace `inregion175_`, from the image built for #173 at
commit `15542eb` (harness machine `<shop-harness-machine-id>`), both scenarios in one machine start:
`tenant-load` from 10:54:25Z to 11:00:44Z, then `outbox-backlog` to 11:06:49Z. Both reports were
collected, one part each, before the machine was stopped.

### `tenant-load`

PASS, 378,707ms, no failures. All 5,000 orders (4,905 from the large tenant, 5 from each small
one) had their plain handler effects at 314,305ms, inside the 20-minute (1,200,000ms) window, and
all 5,000 `watch-shipping` runs had a terminal row at 314,372ms, inside the 15-minute (900,000ms)
window. That is about 80 handler rows a second (25,000 rows in 314 seconds), or about 16 orders a
second. This is the first Fly run on this page to meet both windows. On the Starter plan (#173)
the same scenario missed both, at 2,422,223ms; on Basic with the smaller engine (#166) it missed
the durable window, at 2,300,934ms. Report sha256
`42fc7ec8bdb00c66878814557f074b4d3ecbfd9a82a135ade7498c54d9ea211f` (of the report as collected,
matching the harness's own `report-written` log line, as in earlier runs on this page), stored
whole; the stored copy under `docs/proofs/data/` carries a trailing newline the collector's file
does not, so its own sha256 differs.

### `outbox-backlog`

FAIL, 365,169ms. At the 5-minute (300,000ms) window, 600 of 50,000 rows (1.2%) were still pending;
the report's 601 failure entries are those 600 rows plus the aggregate line `backlog of 50000
rows never drained within 300000ms`. Rows drained: 49,400. Over the 305,169ms left after the
60-second teardown quiet period, that is about **162 rows a second**: the same as the in-region
run on Basic (#166, ~161) and the laptop-to-Fly run (~162), up from ~56 on Starter (#173), and
still far below the laptop-only run's 996. The window needs about 167 rows a second (50,000 in
300 seconds), so this is a near miss. Nothing here contradicts must-hold: every pending row was
still in the outbox, not lost, not doubled.

The relay pushes one batch of 100 rows at a time (`packages/sdk/src/relay/relay.ts`), so ~162 rows
a second is about 0.6 seconds per batch, on Basic, on Launch, in-region and from New Zealand
alike, where the same relay against a local engine took about 0.1 seconds. A better database did
not make batches faster; a worse one (Starter) made them slower. That suggests this scenario's
ceiling is the relay's one-batch-at-a-time push or the engine's intake of pushed events, not the
database plan. This run does not tell those two apart.

Report sha256 `a8e41de0d964e567377ba4ce59a3060f299d4f25445b770b70483dd48be01c40` (of the report as
collected, matching the #173 precedent), 87,568 bytes.
Stored copy capped `{ shown: 21, total: 601 }` (20 pending rows plus the aggregate line, the `#164`
pattern); its own sha256 differs from the one above because the cap script drops rows and adds a
trailing newline.

### Engine log

Machine `<engine-machine-id>`, 10:54:22Z to 11:07:00Z, counted with `grep` on the log with colour
codes removed: 3,805 lines, every one a warning (`WRN`), **no `ERR` line**. By kind: 1,677
`concurrency strategy … took longer than 100ms`; 727 `long transaction`; 353 `queue took longer
than 100ms to process and flush items`; 236 `flushing items to database took longer than
100ms (N items in Xms)`; 76 `processing internal event matches`; 54 `replenishing slots took
longer than`; 50 `listing actions for workers`; 30 `connecting to localhost:7077 without TLS`.
Four more kinds exceed 12: 237 `flushing N items to database took longer than 100ms`
(a second, distinct message from the 236 above — this one carries `ack_duration`/`item_count`
fields instead of the `(N items in Xms)` suffix); 219 `queue processing took longer than
100ms`; 81 `marking queue items processed took longer than 100ms`; 38 `listing N queue items
for queue …`. The remaining 27 lines are three smaller kinds: 14 `processing batch of N queue
items took longer than 100ms`, 11 `assigning queue items took longer than 100ms`, 2 `long lock`.
`tenant-load` accounts for 2,769 of them, `outbox-backlog` for 1,036. None of the
#173 error kinds appears: no `failed to send callback completed message`, `error adding message
for queue`, `error binding queue`, `context deadline exceeded`, or connection-slot error. The one
`ERR` line in the whole tail (`error replenishing slots … context deadline exceeded`) is at
10:50:21Z, between the smoke run and the report run.

### Harness log

From the smoke run's start (10:47:45Z, see above) to the end: no `ERROR` line and no `invalid auth token`
line; 2 heartbeat-delay warnings. The earlier lines in the saved tail belong to the #173 run.
#173 had one `invalid auth token` line during a run whose engine log showed queue timeouts; this
run had neither. That fits the token error being a symptom of the engine's queue falling behind,
not a separate token fault. It does not prove it.

### What this supports

For `tenant-load`, the first of issue #175's three readings: **on the engine's Postgres-backed
queue, the database plan was the ceiling.** With only the plan changed, the scenario went from
missing both windows to meeting both with about 10 minutes to spare, and the engine's queue errors
went from hundreds to none.

For `outbox-backlog`, none of the three readings fits cleanly. The drain rate is back where it was
on Basic, so the database plan is not what holds it at ~162 rows a second; a 1.2% miss makes it a
near miss rather than a collapse. For scale, the design's release-one target (N4) is 10 messages
a second sustained and 100 a second in bursts; this scenario asks for about 167.

**Issue #162, criterion 3** (the three load scenarios pass at report size on the deployed engine):
still not met. `engine-outage` passed (laptop to Fly) and `tenant-load` now passes in-region;
`outbox-backlog` still misses its window. For the decision issue #162 is waiting on, the evidence
says: Launch, or better, is the database plan for the engine's cluster in any environment that
runs this load on the Postgres-backed queue. The next run (issue #176) moves the engine's internal
queue to RabbitMQ, which tests whether the engine's side of the push is what holds
`outbox-backlog` back. The CTO decides what follows.

## Engine queue on RabbitMQ (issue #176)

What this is: the same `tenant-load` and `outbox-backlog` runs as issue #175, on the same engine machine (`<engine-machine-id>`, `performance-2x`), the same Launch plan on both clusters and the same harness image, after the engine's internal message queue moved from Postgres to RabbitMQ (`<rabbitmq-app>`). All times are 2026-09-23, UTC.

### What this run does not prove
- **This list was written after the run.**
- **One run.** Not repeated, not averaged.
- **The engine also restarted.** Switching the queue needs a deploy, and a deploy restarts the engine. The report run started about 13 minutes after the engine booted; #175's ran on an engine that had been up about two hours. The laptop proof saw a busy engine drain `outbox-backlog` slower than a fresh one (996 against 1,657 rows a second — the 1,657 figure is from a solo 5,000-row confirmation run against a freshly started engine, not a 50,000-row backlog). This run cannot separate the queue from the restart.
- **It is not Hatchet's production shape.** It is hatchet-lite in RabbitMQ mode: one engine machine and one single-node RabbitMQ machine (`rabbitmq:3.13.7`, `performance-1x`), dev-sized. Not the separate engine and dashboard images, not more than one engine, not a RabbitMQ cluster.
- **No CPU, memory, database or RabbitMQ metrics were read.** RabbitMQ's queue depths were not recorded.
- **Nothing here tests RabbitMQ going away.** `engine-outage` and the other seven scenarios were not re-run on this queue; the engine-process restart case stays unproven.
- **The logs are saved tails.** The engine tail starts at 12:15:46Z, after the engine booted, so the boot-log check below comes from reading the log at deploy time, not from the saved tail. Whether a tail kept every line was not checked.
- **The rolled-back-transaction must-hold row is not exercised**, as in every in-region run.

### What was done
RabbitMQ app, machine `<rabbitmq-machine-id>`, volume `<rabbitmq-volume-id>` (3 GB, created with `--vm-size performance-1x`), credentials staged by the CTO before the first deploy, deployed 12:09Z, `amqp` check passing, listener and startup lines at 12:09:34Z, no public IP address. The CTO staged `SERVER_MSGQUEUE_RABBITMQ_URL` and destroyed the stopped rollback machine `<old-engine-machine-id>` and its volume; `fly deploy` at 12:14:31Z updated `<engine-machine-id>` in place on `<engine-config-volume-id>`; `/api/ready` 200; 14 AMQP connections from one private address at 12:14:45Z; boot log had no `Creating new Postgres message queue` line. Smoke: machine start 12:20:38Z (the harness log's own `Machine started in 994ms` line), scenario 12:20:40Z (six minutes after boot; the runbook's wait rule allows a smoke run instead of 10 minutes), namespace `inregion176s_`, PASS 83,109ms (plain 18,776ms, durable 18,781ms), 200 orders, no failures, `report-176-smoke.json`, sha256 `4a0317d219e668cd3a9305fe519a74dfc4519572c632bc01d9cfb1e79a599589` (as collected) — the same as #175's smoke (83,746ms), so at smoke size the queue made no visible difference. Report run: machine start 12:27:18Z (the harness log's own `Machine started in 1.048s` line), namespace `inregion176_`, `tenant-load` 12:27:20Z–12:32:34Z then `outbox-backlog` to 12:34:26Z, both reports collected, one part each, before the machine stopped at 12:35Z.

### `tenant-load`
PASS, 314,404ms, no failures: plain effects for all 5,000 orders at 141,525ms (window 1,200,000ms), a terminal `watch-shipping` row for all 5,000 at 250,261ms (window 900,000ms). About 100 handler rows a second (25,000 in 250 seconds), about 20 orders a second; #175 on the Postgres queue: about 80 and 16. Plain effects took 45% of #175's time (314,305ms), durable 80% (314,372ms). On the Postgres queue both waits ended together; here the durable wait ended 109 seconds after the plain one. Report sha256 `59899cd3af02e595b0a9fc6cd53ba64bc14d367ee64a85ef493e6534b08f007d` (as collected, 988 bytes, matching the harness's `report-written` line), stored whole; the stored copy carries a trailing newline, so its own sha256 differs.

### `outbox-backlog`
PASS, 111,221ms, no failures: 50,000 rows drained in 47,431ms (48 samples; the oldest row peaked at 47.0 seconds). Two rates, and why they differ: **1,054 rows a second** is the harness's own figure, 50,000 rows over the drain timer, which starts once the rows are in and the relay is started — the same timer behind the laptop's 996. **About 976 rows a second** is this page's method for the Fly columns, rows drained over the scenario time minus the 60-second quiet period (51,221ms); that time also includes seeding the rows and the closing reads, about 3.8 seconds here. The earlier Fly runs failed, and a failed run's report has no drain timer, so only this page's method exists for them; the same few seconds would change their ~162 by about 1%. Compared the same way, the drain went from ~162 (#175) to ~976 rows a second, about six times faster, with each 100-row batch taking about 0.1 seconds instead of about 0.6; the window needs about 167. Report sha256 `fec445a86fde13f54d79115f6b55bd9419acadade8eee012d7101963f86bb68a` (as collected, 3,643 bytes), stored whole, trailing newline added.

### Engine log
Machine `<engine-machine-id>`, lines stamped 12:27:16Z through 12:35:00Z (end of the tail), colour codes removed: 12,609 lines, all `WRN`, **no `ERR`** — and no `ERR` anywhere in the tail from 12:15:46Z, the smoke run included. `tenant-load`'s time holds 12,226, `outbox-backlog`'s 331, 52 fall after it (#175: 2,769 and 1,036). By kind: 4,424 `long transaction` (1,193 `optimistic_tx.go`, 1,118 `olap.go`, 888 `durable_events.go`, 519 `task.go`, 339 `match.go`, 298 `scheduler_queue.go`, 69 in three other `pkg/repository` files); 1,900 `concurrency strategy N took longer than 100ms` (1,820 processed 0 items); 1,527 `flushing items to database took longer than 100ms (N items in Xms)` (1,151 for 0 items); 1,524 `flushing N items to database took longer than 100ms` (1,240 of exactly 50 items); 1,342 `queue took longer than 100ms to process and flush items`; 524 `queue processing took longer than 100ms`; 397 `marking queue items processed`; 251 `processing batch of N queue items`; 211 `assigning queue items`; 179 `replenishing slots`; 100 `processing internal event matches`; 82 `checking is_active on concurrency strategy`; 63 `listing N queue items for queue`; 46 `listing actions for workers`; 30 `connecting to localhost:7077 without TLS`; 9 `long lock`. None of the #173 error kinds appears.

These are timers: each line means one step took longer than 100ms. Many are steps with nothing to do — 1,820 of the 1,900 concurrency-strategy lines processed 0 items, and 1,151 of the 1,527 `flushing items to database … (N items in Xms)` lines flushed 0 items. The long-transaction lines all name files under `hatchet/pkg/repository/`, the engine's database code, and 1,361 of them report 50 database connections in use, the highest figure in the log; whether 50 is the engine's limit was not checked. There are more of these lines than in #175 (12,609 against 3,805) although the run was far shorter and faster. They are not failures: every scenario passed with no failure entry and no `ERR` line. They show the engine's database work slowing under this load.

### RabbitMQ log
Machine `<rabbitmq-machine-id>`, saved tail of 100 lines from 12:09:31Z to 12:14:45Z, read after the run: no `alarm` line and no error line. Three warning lines, all at boot: one first-boot `rebuilding indices from scratch` and two `Reaped child process` lines from Fly's init. The tail has no line after 12:14:45Z, so RabbitMQ logged nothing at all during either run, no memory or disk alarm included.

### Harness log
From the smoke run's start to the end: no `ERROR` line and no `invalid auth token` line; one heartbeat-delay warning (4,936ms against 4,000ms) at 12:20:46Z, during the smoke run, and none during the report run.

### What this supports
- **With the queue on RabbitMQ, every scenario met its window in-region, with room to spare**: `tenant-load` in 142 of 1,200 seconds (plain) and 250 of 900 (durable); `outbox-backlog` in 47 of 300.
- **The ceiling for `outbox-backlog` was on the engine's side, not the relay's push path.** The relay code, its 100-row batch and its one-batch-at-a-time push did not change (same image); only the engine's queue and its restart did, and the two cannot be separated (see above). The drain went from ~162 to ~976 rows a second, back to what the laptop reached against a local engine.
- **Plain handler effects settled in a little under half the time** (141,525 against 314,305ms). The durable wait improved less (250,261 against 314,372ms).
- **The remaining warnings are slow steps in the engine's database work**, not failures. They are the next thing to watch at larger scale, starting with the database connections in use.

**Issue #162, criterion 3** (the three load scenarios pass at report size on the deployed engine): **met: two scenarios on this topology, `engine-outage` from the #162 Postgres-queue run, not re-run.** `tenant-load` and `outbox-backlog` pass in-region with the queue on RabbitMQ; `engine-outage` passed against the deployed engine in #162's laptop-to-Fly run, on the Postgres queue, and was not re-run on RabbitMQ.

**For the Camba decision**, the evidence supports: the dev engine on hatchet-lite, with its queue on RabbitMQ and both clusters on Launch, handled this report-size load with no lost or doubled effect, no error line and all windows met. It does not support: any claim about production — one run; hatchet-lite in RabbitMQ mode, not Hatchet's separate-image production shape; one engine machine and one RabbitMQ node; dev-sized machines; no metrics; and an engine restart that coincided with the queue change. Keeping RabbitMQ adds a datastore family, which requirement N1 in the design document rules out as written. The CTO decides whether RabbitMQ stays and what follows.
