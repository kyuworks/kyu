# Kyu 急

The company message bus: events, commands and durable workflow orchestration for every internal project, built on self-hosted [Hatchet](https://github.com/hatchet-dev/hatchet).

Kyu sounds like queue, and the kanji 急 (kyū) means urgent or express, as in express delivery. The kanji is the logo. A message is express: it is delivered promptly to the consumers that subscribed, and nowhere else.

Formerly Qtaxis (and before that Kinesin); renamed on 2026-09-19.

## Start here

- [Design](docs/design/kyu-requirements-and-design.md): requirements, architecture, the Camba integration plan.
- [Decisions](docs/architecture/adr/): why it is standalone, why Hatchet, why migrations are immutable, why user-defined workflows run through one interpreter.
- [Contributing](CONTRIBUTING.md): setup, the loop, layout, gates.
- [Agent notes](AGENTS.md): the rules agents work under. [Glossary](CONTEXT.md).

## Quick start

```bash
pnpm install
pnpm hatchet:up
export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/token.sh)"
export HATCHET_CLIENT_TLS_STRATEGY=none
export KYU_TEST_DATABASE_URL=postgresql://hatchet:hatchet@localhost:15432/kyu_test
pnpm check
```

## Packages

| Package | Purpose |
| --- | --- |
| `@kyuworks/schemas` | The envelope contract, naming rules, schema adapters |
| `@kyuworks/sdk` | Publish through a transactional outbox, subscribe with Hatchet, run durable handlers, read a run's outcome by envelope id, read every run for one correlation id, cancel a run by envelope id or correlation id |

A process that only publishes needs no engine credentials. `createPublisher({ source })` returns
just `publish`, writes the outbox row inside the caller's transaction and never builds an engine
client, so a web API or a CLI needs only its own database. `createKyu({ hatchet, source })` is for
a process that also subscribes, runs a worker, starts the relay or reads run outcomes; those need
`HATCHET_CLIENT_TOKEN`, and `createHatchetClient()` throws "API token is required" the moment it is
called without one.

A subscription's `name` must be lowercase letters, digits, `-` or `_`, starting with a letter.
`subscribe()` and `durable()` refuse anything else, because the engine lowercases the name when it
registers the workflow and `runs.forEnvelope()` would then report a name the caller never chose.

Run the relay on a small dedicated `pg.Pool` (the shop uses `max: 1`), not the application's pool and not a bare `pg.Client` (`kyu.startRelay({ db: pool, workerId })`). The relay never opens a transaction — a claim is held by the row's `claimed_by` stamp, not by the connection — so a pool is safe, and pg replaces a dropped connection on the next tick. `publish()` and `onceById()` still refuse a pool: their statements must land in the caller's transaction. Attach `pool.on('error', …)`, or a connection dropped while idle takes the process down.

A relay handed a single `pg.Client` cannot recover: pg marks a client that lost its connection permanently unusable. The relay notices, stops polling, calls `onError` with a `RelayConnectionLostError` and rejects `relay.closed`. Exit non-zero on that rejection and let a supervisor restart the process. Rows the relay had claimed stay claimed until `staleClaimMs` passes, then another relay takes them over.

A row whose `envelope` column does not parse can never be shipped: the column is written once and never changed. The relay records the reason in `last_error`, and on the third such claim stamps `dead_at` and stops claiming the row, so it leaves the pending set instead of climbing `attempts` for ever. Retired rows appear on `onTick(result).retired` and in `SELECT … FROM kyu_outbox WHERE dead_at IS NOT NULL`, and `pruneRetired({ retiredBefore })` deletes them once they have been looked at. Rows that fail to push are not retired: the engine being down is temporary, and those keep retrying. A retired row is a message that will never be delivered, and a permanent gap in its key's order. An operator who fixes the envelope by hand revives the row with `UPDATE kyu_outbox SET dead_at = NULL, attempts = 0, last_error = NULL WHERE id = $1`, so the relay claims it again.

`publish(tx, definition, data, { tenantId, publishAt })` holds a message back until `publishAt`. The row is written in the caller's transaction like any other, so a rollback cancels it; the relay simply does not claim it until its time. The envelope id and `correlationId` are minted when `publish()` runs, not when the row ships, so a redelivered scheduled message carries the id the caller already has. A past `publishAt` is due at once, and an invalid `Date` throws. A scheduled message has no publish-order guarantee against messages published after it: it arrives at its own time. Consumers must apply migration `20260922022251_outbox_publish_at.sql` before deploying an SDK version that carries this feature.

A durable run cannot outlast its `executionTimeout`, which `durable()` sets to 24 hours when the caller does not: the engine cancels a run whose sleeps and waits pass it, mid-wait. `sleepFor` and `waitFor` are for waits inside that ceiling. For a longer wait, hand it off instead of sleeping: in one transaction, record where the run got to and publish the handler's own trigger message again with `publishAt` set to the wake time and a field saying where to continue, then return. The run ends holding nothing, and the relay starts a fresh run at the wake time. `examples/shop/src/handlers/runWorkflow.ts` does this for a workflow delay step of 60 seconds or more.

A durable run parked in `sleepFor`/`waitFor` reads as `running` in that outcome — the engine exposes no separate parked state. A run reads `completed` only once the engine has recorded both `startedAt` and `finishedAt`, and `failed` only once it has recorded `finishedAt`; a run caught in the gap between the terminal status and those timestamps reads `running` instead. A failed run may have no `startedAt` at all, because it can end before any worker starts it.

`kyu.runs.forCorrelation(correlationId)` returns every run that shares one correlation id — a durable run and the command runs it published — oldest first, ordered by the engine's `createdAt` and then by run id. `forEnvelope` returns one message's runs newest first, because it answers what happened most recently; `forCorrelation` reads like a progress list, so it runs the other way. A run that is still `running` also carries `waiting` when it is parked: `{ kind: 'sleep', until }` for `sleepFor`, or `{ kind: 'message', name, field, equals }` for `waitFor`. The engine has no parked status, so `waiting` is what tells the two apart. A run that has finished, failed or been cancelled never carries one. Each parked run costs one extra engine read. A run parked by an SDK version older than this one has no wait label, and `forCorrelation` raises `KyuError` rather than reporting a field match that was never registered; it clears when that run ends.

`kyu.runs.cancelForEnvelope(envelopeId)` cancels every run the engine holds for one envelope id. `kyu.runs.cancelForCorrelation(correlationId)` cancels every run that shares one correlation id — a durable run and the command runs it published. Both return the runs they asked the engine to cancel, as those runs read the moment before. An id the engine has no run for returns an empty array and makes no cancel call, and an id that is not a uuid v7 throws before the engine is called at all. Both match on the engine's own run metadata, so a run in another namespace, or under another correlation id, is never touched. Cancelling a run that has already finished does nothing and raises nothing, so calling either twice is safe.

A cancelled run ends as `cancelled`, not `failed`, and the engine does not retry it. A run parked in `sleepFor`/`waitFor` sees that wait reject as soon as the cancel reaches its worker — about 0.3 seconds on the local stack. Let the rejection propagate. A handler that is between two steps when the cancel arrives is not interrupted: JavaScript cannot stop a running body, so the handler finishes the step it is in and the engine drops the result. That is what keeps a cancel out of the middle of an `onceById` transaction. Do not try to tell a cancellation from an eviction inside a handler — the engine SDK aborts the same controller and raises the same `AbortError` for both, and an evicted run is one that will carry on somewhere else.

`worker.stop()` first refuses any new durable wait on that worker, then pauses the worker, evicts every parked durable run and waits for the bodies still running. A handler that reaches its first `sleepFor`/`waitFor` during the stop fails that attempt straight away and the engine retries it on whichever worker is available; `durable()` sets `retries` to 3 for this reason, and an explicit value still wins. The flag is one-way, so `createWorker` refuses a durable subscription object another worker already bound: build one subscription per worker.

A durable handler that must re-check a condition over its own data parks again after every wake: `waitFor` with the same `where`, and `afterMessage` set to the envelope the last wake returned. Envelope ids are uuid v7, so the wait matches only messages published after that one and the message that woke the handler never wakes it again. A message that lands while the handler is between the wake and the next park is still matched, because the lookback window covers it. The window is anchored at the run's start, not at each park — the engine memoises `now()` per run — so it grows with the run's age and never loses a message that lands between a wake and the next park. A message published before the last wake but delivered to the engine after it is not matched; the wait's `timeout` is the backstop, and the handler re-reads its own state on a timeout too. Each park is one durable wait, counted by its position in the run, so a restart replays the same sequence and re-runs no completed step.

Eviction of an already-parked run is the slow part: the engine SDK waits up to 30 seconds per run for the engine to acknowledge it, so size a supervisor's SIGTERM grace period above that — or pass `stopTimeoutMs` to `createWorker` to cap the whole stop.

`kyu.schedules.create({ name, cron, definition, data, tenantId })` registers a cron that publishes a message on a schedule; `remove` and `list` manage what is registered. A cron hangs off `kyu.scheduleRunner`'s workflow, which a worker must register before `create`, `remove` or `list` — call each only after `kyu.worker(...)` with `kyu.scheduleRunner({ db, definitions })` in its subscriptions has started, or the SDK throws a `KyuError` saying so instead of the engine's own bare "workflow not found". A cron's name is unique within this client's namespace, not across every consumer.

## Examples

[`examples/shop`](examples/shop) is a small app that uses `@kyuworks/sdk` the way a real project would.

Status: design accepted, SDK in progress. See the issues.
