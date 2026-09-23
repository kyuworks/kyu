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

Fixed in #165: `cancelLeftoverRuns` now settles only after the namespace has stayed empty for 60
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
  teardown; the 19 leftovers below were cancelled afterwards (see below).
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

| | Laptop only | Laptop to Fly | In-region |
|---|---|---|---|
| Harness, relay, worker run | laptop (NZ) | laptop (NZ) | `<shop-harness-app>`, `syd` |
| Machine size | laptop spec | laptop spec | `performance-2x` (2 dedicated vCPU, 4 GB) |
| Shop database | local Docker Postgres | local Docker Postgres | `<shop-harness-db>`, Basic, `syd` |
| Engine | local compose v0.107.0 | `<engine-app>`, `performance-1x` | same |
| Network path | loopback | NZ→`syd` public edge, TLS, median 143ms | `syd` internal 6PN, plaintext |
| `outbox-backlog` | PASS, 50,221ms, 996 rows/sec | FAIL, 301,762ms, ~162 rows/sec | FAIL, 304,063ms, ~161 rows/sec |
| `tenant-load` | PASS, 221,426ms, 50/200 slots | FAIL, 1,813,911ms | FAIL, 2,300,934ms |
| Commit | — | `caa4dc1...-dirty` | `9c9ae54` |
| JSON file | `docs/proofs/data/report-155-*.json` | `docs/proofs/data/report-162b-*.json` | `docs/proofs/data/report-166-*.json` |

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
0 `invalid auth token` lines and passed. A locally minted token on the same engine version lasts 90
days, and the engine has not restarted since 2026-09-22T13:10Z. Read together with the 0-line,
passing result, this points at load-related token validation on the engine side, not a fault with
the token itself.

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
`cancelNamespaceCli.js` found 18 of them still queued or running and left 18 (issue #165), the same
as the laptop-to-Fly run's leftovers, but the relationship between the two is not established — in the
laptop-to-Fly run the runs reappeared after a first check had already reported the namespace empty
(§ Cleanup gap, above), where here the harness's own single final check found the 19 directly, with
no earlier "empty" check for them to have reappeared after. Against 5,000 orders each expected to
produce four handler rows, this is a small tail — unlike the laptop-only run, which had zero
failures; only the laptop-to-Fly run showed a comparable tail. The harness's `no-effect-lost` check
failed for the 7 orders above plus the aggregate line, so those effects were not seen within the
window and whether they ever ran at all is unknown; the outbox rows themselves were not lost.

**Reading the two results together:** neither scenario got faster or more accurate by moving the
harness, the relay and the worker into `syd`. That rules out the cross-Tasman network hop as the
sole or even primary cause of the laptop-to-Fly misses; the engine's own queueing under this load
size, on a `performance-1x` machine, is the more likely ceiling, consistent with the
`HeartbeatController`/`Dispatcher` error pattern logged during this run. A larger engine machine or
a smaller load size were not tried here — #166 asked only for the in-region measurement, not a
capacity fix.
