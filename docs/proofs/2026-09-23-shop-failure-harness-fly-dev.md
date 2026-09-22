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

_Filled in after the run (Step 2 of the plan)._

## The network path

_Filled in after the run: the harness, the relay, the worker, the shop's Postgres and the outbox
all run on this laptop in New Zealand; only the engine and its database are in Sydney. Measured
round trip and the ten `curl` samples it is built from go here._

## Results table

_Filled in after the run._

| Scenario | Result | Wall time on Fly | Wall time on the laptop | Ratio |
|---|---|---|---|---|
| `engine-outage` | — | — | 103.5s | — |
| `outbox-backlog` | — | — | 50,221ms (996 rows/sec) | — |
| `tenant-load` | — | — | 221,426ms (50/200 slots) | — |

## Throughput

_Filled in after the run: rows/sec for `outbox-backlog` against the laptop's 996 rows/sec; handler
rows/sec and orders/sec for `tenant-load` against the laptop's ~370 handler rows/sec and ~119
orders/sec; which scenario the WAN link hurt more, and why._

## Engine outage against Fly

_Filled in after the run — see the plan's "Engine outage against Fly: what it proves" section for
what a proxy cut does and does not show, and whether the CTO also rehearsed a real machine
stop/start._

## Restore rehearsal

_Filled in after Step 3 of the plan: backup id and timestamp, destination cluster name, the three
numbers the CTO reported back, how long the restore took, and confirmation the throwaway cluster
was destroyed._
