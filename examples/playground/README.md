# Kinesin playground

A small app that uses `@kinesin/sdk` the way a real project would. It sells nothing real; the
messages are named `shop.*` as a neutral stand-in.

Three processes share one Postgres database and one Hatchet engine:

- **migrate** — applies the SDK's shipped migrations, then this app's own, through its own runner.
- **relay** — ships the transactional outbox to the engine.
- **worker** — runs the event and command handlers.

`worker` runs `record-order` and `audit-order` (two subscribers on `shop.order.placed`),
`send-invoice` (a FIFO-per-order command handler, `shop.invoice.send`), and `watch-shipping`, a
durable handler that sleeps five seconds and then waits for the correlated `shop.order.shipped`
event. Killing and restarting the worker while a run is parked in that wait proves the run
resumes in the new process, not the one that started it.

A worker stopped while `watch-shipping`'s body is still executing fails that attempt, and the
engine retries it on the next worker to start. A worker stopped once the run is parked in its
wait hands the wait to the next worker directly, with no failed attempt in between.

The relay owns one dedicated `pg.Client`, not a pool (the SDK's `Queryable` rejects a pool by
design). It has no reconnect: if that connection drops, the process logs the error and exits
non-zero rather than stopping quietly. A real deployment runs it under a supervisor that
restarts it — `pnpm --filter @kinesin/playground relay` alone does not.

A relay stopped by SIGTERM releases its claimed rows before exiting. A relay killed without
SIGTERM (a crash, a supervisor's SIGKILL) leaves its claims stale for 30 seconds before another
relay takes them over.

## Producer CLI

```bash
pnpm --filter @kinesin/playground publish-cli place-order --tenant <uuid> [--customer <uuid>]
pnpm --filter @kinesin/playground publish-cli ship-order --tenant <uuid> --order <uuid> [--carrier <name>]
```

Each command commits one transaction and prints the ids it created as one JSON line. A missing
`--tenant` (or `--order` for `ship-order`) prints an error and exits 1; an unknown command does
the same.

## Web page

```bash
pnpm --filter @kinesin/playground ui
```

Serves the same two forms on `http://127.0.0.1:3333` (`KINESIN_EXAMPLE_UI_PORT` to change the
port). The page sends ids and shows the ids it got back; it does not read handler logs or run
status. Watch what happens next in the Hatchet dashboard.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KINESIN_EXAMPLE_DATABASE_URL` | yes | — | Postgres connection string for this app's own database. |
| `KINESIN_EXAMPLE_NAMESPACE` | no | `playground_` | Shared prefix so the three processes agree on one run. |
| `KINESIN_EXAMPLE_LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, `error`. |
| `KINESIN_EXAMPLE_WATCH_TIMEOUT` | no | `3m` | `watch-shipping`'s correlated wait timeout; an h/m/s duration string. |
| `KINESIN_EXAMPLE_RELAY_BATCH_SIZE` | no | the SDK's default | Read only by `relay`; rows claimed per tick. |
| `KINESIN_EXAMPLE_UI_PORT` | no | `3333` | Read only by `ui`; the local port the web page binds to. |
| `HATCHET_CLIENT_TOKEN` | yes | — | Read by the engine client directly, same as the SDK's own integration lane. |
| `HATCHET_CLIENT_TLS_STRATEGY` | yes | — | Read by the engine client directly. |

The namespace is a prefix; the engine lowercases it and gives it a trailing underscore if one
is missing.

## Run it locally

```bash
pnpm hatchet:up
export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/token.sh)"
export HATCHET_CLIENT_TLS_STRATEGY=none
pnpm --filter @kinesin/playground build
pnpm --filter @kinesin/playground migrate
pnpm --filter @kinesin/playground relay
```

`relay` blocks in its own terminal, polling the outbox until you stop it with Ctrl-C. Run
`worker` in a second terminal, with the same environment variables exported there too, then run
the CLI in a third:

```bash
pnpm --filter @kinesin/playground worker
pnpm --filter @kinesin/playground publish-cli place-order --tenant <uuid>
```

`HATCHET_CLIENT_TOKEN` and `HATCHET_CLIENT_TLS_STRATEGY` are needed by the relay, the worker and
the CLI's producers, not by migrate.

## Engine hygiene

Each test run registers workflows and a concurrency strategy under a random namespace that the
engine never removes. Run `pnpm hatchet:down -v` then `pnpm hatchet:up` periodically to clear
the accumulated registrations and keep the local engine responsive.
