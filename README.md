# Qtaxis

The company message bus: events, commands and durable workflow orchestration for every internal project, built on self-hosted [Hatchet](https://github.com/hatchet-dev/hatchet).

Qtaxis is q for queue plus taxis, the biology term for directed movement toward a stimulus. A message moves deliberately toward the consumers that asked for it.

Formerly Kinesin; renamed on 2026-09-18.

## Start here

- [Design](docs/design/qtaxis-requirements-and-design.md): requirements, architecture, the Camba integration plan.
- [Decisions](docs/architecture/adr/): why it is standalone, why Hatchet, why migrations are immutable.
- [Contributing](CONTRIBUTING.md): setup, the loop, layout, gates.
- [Agent notes](AGENTS.md): the rules agents work under. [Glossary](CONTEXT.md).

## Quick start

```bash
pnpm install
pnpm hatchet:up
export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/token.sh)"
export HATCHET_CLIENT_TLS_STRATEGY=none
export QTAXIS_TEST_DATABASE_URL=postgresql://hatchet:hatchet@localhost:15432/qtaxis_test
pnpm check
```

## Packages

| Package | Purpose |
| --- | --- |
| `@qtaxis/schemas` | The envelope contract, naming rules, schema adapters |
| `@qtaxis/sdk` | Publish through a transactional outbox, subscribe with Hatchet, run durable handlers, read a run's outcome by envelope id |

## Examples

[`examples/playground`](examples/playground) is a small app that uses `@qtaxis/sdk` the way a real project would.

Status: design accepted, SDK in progress. See the issues.
