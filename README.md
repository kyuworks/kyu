# Kyu 急

The company message bus: events, commands and durable workflow orchestration for every internal project, built on self-hosted [Hatchet](https://github.com/hatchet-dev/hatchet).

Kyu sounds like queue, and the kanji 急 (kyū) means urgent or express, as in express delivery. The kanji is the logo. A message is express: it is delivered promptly to the consumers that subscribed, and nowhere else.

Formerly Qtaxis (and before that Kinesin); renamed on 2026-09-19.

## Start here

- [Design](docs/design/kyu-requirements-and-design.md): requirements, architecture, the Camba integration plan.
- [Decisions](docs/architecture/adr/): why it is standalone, why Hatchet, why migrations are immutable.
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

A durable run parked in `sleepFor`/`waitFor` reads as `running` in that outcome — the engine exposes no separate parked state.

`worker.stop()` first refuses any new durable wait on that worker, then pauses the worker, evicts every parked durable run and waits for the bodies still running. A handler that reaches its first `sleepFor`/`waitFor` during the stop fails that attempt straight away and the engine retries it on whichever worker is available; `durable()` sets `retries` to 3 for this reason, and an explicit value still wins.

Eviction of an already-parked run is the slow part: the engine SDK waits up to 30 seconds per run for the engine to acknowledge it, so size a supervisor's SIGTERM grace period above that — or pass `stopTimeoutMs` to `createWorker` to cap the whole stop.

## Examples

[`examples/shop`](examples/shop) is a small app that uses `@kyuworks/sdk` the way a real project would.

Status: design accepted, SDK in progress. See the issues.
