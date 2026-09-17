# Kinesin playground

A small app that uses `@kinesin/sdk` the way a real project would. It sells nothing real; the
messages are named `shop.*` as a neutral stand-in.

Three processes share one Postgres database and one Hatchet engine:

- **migrate** — applies the SDK's shipped migrations, then this app's own, through its own runner.
- **relay** — ships the transactional outbox to the engine.
- **worker** — runs the event and command handlers.

This PR adds `worker` and its handlers: `record-order` and `audit-order` (two subscribers on
`shop.order.placed`) and `send-invoice` (a FIFO-per-order command handler, `shop.invoice.send`).
A later PR adds a durable handler that waits for a shipped event.

The relay owns one dedicated `pg.Client`, not a pool (the SDK's `Queryable` rejects a pool by
design). It has no reconnect: if that connection drops, the process logs the error and exits
non-zero rather than stopping quietly. A real deployment runs it under a supervisor that
restarts it — `pnpm --filter @kinesin/playground relay` alone does not.

## Producer CLI

```bash
pnpm --filter @kinesin/playground publish-cli place-order --tenant <uuid> [--customer <uuid>]
pnpm --filter @kinesin/playground publish-cli ship-order --tenant <uuid> --order <uuid> [--carrier <name>]
```

Each command commits one transaction and prints the ids it created as one JSON line. A missing
`--tenant` (or `--order` for `ship-order`) prints an error and exits 1; an unknown command does
the same.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KINESIN_EXAMPLE_DATABASE_URL` | yes | — | Postgres connection string for this app's own database. |
| `KINESIN_EXAMPLE_NAMESPACE` | no | `playground_` | Shared prefix so the three processes agree on one run. |
| `KINESIN_EXAMPLE_LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, `error`. |
| `HATCHET_CLIENT_TOKEN` | yes | — | Read by the engine client directly, same as the SDK's own integration lane. |
| `HATCHET_CLIENT_TLS_STRATEGY` | yes | — | Read by the engine client directly. |

The namespace is a prefix; the engine lowercases it and gives it a trailing underscore if one
is missing.

## Run it locally

```bash
pnpm hatchet:up
export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/token.sh)"
export HATCHET_CLIENT_TLS_STRATEGY=none
pnpm --filter @kinesin/playground migrate
pnpm --filter @kinesin/playground relay
pnpm --filter @kinesin/playground worker
pnpm --filter @kinesin/playground publish-cli place-order --tenant <uuid>
```

`HATCHET_CLIENT_TOKEN` and `HATCHET_CLIENT_TLS_STRATEGY` are needed by the relay, the worker and
the CLI's producers, not by migrate.
