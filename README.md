# Kinesin

The company message bus: events, commands and durable workflow orchestration for every internal project, built on self-hosted [Hatchet](https://github.com/hatchet-dev/hatchet).

Kinesin is the motor protein that carries cargo along the microtubule tracks inside every cell. This system does the same for messages.

## Start here

- [Design](docs/design/kinesin-requirements-and-design.md): requirements, architecture, the Camba integration plan.
- [Decisions](docs/architecture/adr/): why it is standalone, why Hatchet, why migrations are immutable.
- [Contributing](CONTRIBUTING.md): setup, the loop, layout, gates.
- [Agent notes](AGENTS.md): the rules agents work under. [Glossary](CONTEXT.md).

## Quick start

```bash
pnpm install
pnpm hatchet:up
export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/token.sh)"
export HATCHET_CLIENT_TLS_STRATEGY=none
export KINESIN_TEST_DATABASE_URL=postgresql://hatchet:hatchet@localhost:15432/kinesin_test
pnpm check
```

## Packages

| Package | Purpose |
| --- | --- |
| `@kinesin/schemas` | The envelope contract, naming rules, schema adapters |
| `@kinesin/sdk` | Publish through a transactional outbox, subscribe with Hatchet, run durable handlers |

Status: design accepted, SDK in progress. See the issues.
