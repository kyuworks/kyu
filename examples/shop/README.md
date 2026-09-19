# Qtaxis shop

A small app that uses `@qtaxis/sdk` the way a real project would. It sells nothing real; the
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
restarts it — `pnpm --filter @qtaxis/shop relay` alone does not.

A relay stopped by SIGTERM releases its claimed rows before exiting. A relay killed without
SIGTERM (a crash, a supervisor's SIGKILL) leaves its claims stale for 30 seconds before another
relay takes them over.

## Producer CLI

```bash
pnpm --filter @qtaxis/shop publish-cli place-order --tenant <uuid> [--customer <uuid>]
pnpm --filter @qtaxis/shop publish-cli ship-order --tenant <uuid> --order <uuid> [--carrier <name>]
```

Each command commits one transaction and prints the ids it created as one JSON line. A missing
`--tenant` (or `--order` for `ship-order`) prints an error and exits 1; an unknown command does
the same.

## Web page

A Vite + React app under `web/`, built to `dist/web/` by `pnpm --filter @qtaxis/shop build`
(`tsc -b && vite build`) and served from there by the `ui` process:

```bash
pnpm --filter @qtaxis/shop build
pnpm --filter @qtaxis/shop ui
```

Open `http://127.0.0.1:3333` (`QTAXIS_SHOP_UI_PORT` to change the port). For hot reload during
development, run `pnpm --filter @qtaxis/shop web:dev` instead: it proxies the JSON and POST
routes to the `ui` process, which must already be running.

`web/` uses bundler module resolution, so its own relative imports carry no `.js` extension —
unlike `src/`, which is NodeNext and always does. Do not mix the two styles inside `web/`.
`typecheck:tests` type-checks `web/` too, through `tsconfig.web.json`. `web/index.html` is not
picked up by `pnpm format` or by the changed-file selector; it is not worth a glob for one file.

Publishing from the browser is on hold until the shop pages land in a later pull request — use
the producer CLI above meanwhile.

`/bus` draws the producer, the outbox, and one box per subscription, refreshed every 5 seconds.
Outbox stages — published, waiting for relay, shipped — come from `qtaxis_outbox`. Each
subscription's queued, running, done, failed and cancelled counts come from the engine, through
the SDK's `runs.forEnvelope`, one call per message over the newest 200 subscribed messages.
`watch-shipping`'s parked count and its shipped/timed-out split under "done" come from
`shop_handler_log`. The ui process now needs a reachable engine to serve `/bus.json`; the page
shows an error line instead of stale counts when it is down.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `QTAXIS_SHOP_DATABASE_URL` | yes | — | Postgres connection string for this app's own database. |
| `QTAXIS_SHOP_NAMESPACE` | no | `shop_` | Shared prefix so the three processes agree on one run. |
| `QTAXIS_SHOP_LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, `error`. |
| `QTAXIS_SHOP_WATCH_TIMEOUT` | no | `3m` | `watch-shipping`'s correlated wait timeout; an h/m/s duration string. |
| `QTAXIS_SHOP_RELAY_BATCH_SIZE` | no | the SDK's default | Read only by `relay`; rows claimed per tick. |
| `QTAXIS_SHOP_UI_PORT` | no | `3333` | Read only by `ui`; the local port the web page binds to. |
| `HATCHET_CLIENT_TOKEN` | yes | — | Read by the engine client directly, same as the SDK's own integration lane. |
| `HATCHET_CLIENT_TLS_STRATEGY` | yes | — | Read by the engine client directly. |

The namespace is a prefix; the engine lowercases it and gives it a trailing underscore if one
is missing.

## Run it locally

```bash
pnpm hatchet:up
export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/token.sh)"
export HATCHET_CLIENT_TLS_STRATEGY=none
pnpm --filter @qtaxis/shop build
pnpm --filter @qtaxis/shop migrate
pnpm --filter @qtaxis/shop relay
```

`relay` blocks in its own terminal, polling the outbox until you stop it with Ctrl-C. Run
`worker` in a second terminal, with the same environment variables exported there too, then run
the CLI in a third:

```bash
pnpm --filter @qtaxis/shop worker
pnpm --filter @qtaxis/shop publish-cli place-order --tenant <uuid>
```

`HATCHET_CLIENT_TOKEN` and `HATCHET_CLIENT_TLS_STRATEGY` are needed by the relay, the worker and
the CLI's producers, not by migrate.

## Engine hygiene

Each test run registers workflows and a concurrency strategy under a random namespace that the
engine never removes. Run `pnpm hatchet:down -v` then `pnpm hatchet:up` periodically to clear
the accumulated registrations and keep the local engine responsive.
