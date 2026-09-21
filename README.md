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
| `@kyuworks/sdk` | Publish through a transactional outbox, subscribe with Hatchet, run durable handlers, read a run's outcome by envelope id |

A process that only publishes needs no engine credentials. `createPublisher({ source })` returns
just `publish`, writes the outbox row inside the caller's transaction and never builds an engine
client, so a web API or a CLI needs only its own database. `createKyu({ hatchet, source })` is for
a process that also subscribes, runs a worker, starts the relay or reads run outcomes; those need
`HATCHET_CLIENT_TOKEN`, and `createHatchetClient()` throws "API token is required" the moment it is
called without one.

Run the relay on a small dedicated `pg.Pool` (the shop uses `max: 1`), not the application's pool and not a bare `pg.Client` (`kyu.startRelay({ db: pool, workerId })`). The relay never opens a transaction — a claim is held by the row's `claimed_by` stamp, not by the connection — so a pool is safe, and pg replaces a dropped connection on the next tick. `publish()` and `onceById()` still refuse a pool: their statements must land in the caller's transaction. Attach `pool.on('error', …)`, or a connection dropped while idle takes the process down.

A relay handed a single `pg.Client` cannot recover: pg marks a client that lost its connection permanently unusable. The relay notices, stops polling, calls `onError` with a `RelayConnectionLostError` and rejects `relay.closed`. Exit non-zero on that rejection and let a supervisor restart the process. Rows the relay had claimed stay claimed until `staleClaimMs` passes, then another relay takes them over.

A row whose `envelope` column does not parse can never be shipped: the column is written once and never changed. The relay records the reason in `last_error`, and on the third such claim stamps `dead_at` and stops claiming the row, so it leaves the pending set instead of climbing `attempts` for ever. Retired rows appear on `onTick(result).retired` and in `SELECT … FROM kyu_outbox WHERE dead_at IS NOT NULL`, and `pruneRetired({ retiredBefore })` deletes them once they have been looked at. Rows that fail to push are not retired: the engine being down is temporary, and those keep retrying. A retired row is a message that will never be delivered, and a permanent gap in its key's order. An operator who fixes the envelope by hand revives the row with `UPDATE kyu_outbox SET dead_at = NULL, attempts = 0, last_error = NULL WHERE id = $1`, so the relay claims it again.

A durable run parked in `sleepFor`/`waitFor` reads as `running` in that outcome — the engine exposes no separate parked state. A run's status reads `completed` or `failed` only once the engine has recorded both `startedAt` and `finishedAt`; a run caught in the gap between the engine writing the terminal status and writing those timestamps reads `running` instead.

`worker.stop()` first refuses any new durable wait on that worker, then pauses the worker, evicts every parked durable run and waits for the bodies still running. A handler that reaches its first `sleepFor`/`waitFor` during the stop fails that attempt straight away and the engine retries it on whichever worker is available; `durable()` sets `retries` to 3 for this reason, and an explicit value still wins.

Eviction of an already-parked run is the slow part: the engine SDK waits up to 30 seconds per run for the engine to acknowledge it, so size a supervisor's SIGTERM grace period above that — or pass `stopTimeoutMs` to `createWorker` to cap the whole stop.

## Examples

[`examples/shop`](examples/shop) is a small app that uses `@kyuworks/sdk` the way a real project would.

Status: design accepted, SDK in progress. See the issues.
