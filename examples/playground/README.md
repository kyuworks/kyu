# Kinesin playground

A small app that uses `@kinesin/sdk` the way a real project would. It sells nothing real; the
messages are named `shop.*` as a neutral stand-in.

Three processes share one Postgres database and one Hatchet engine:

- **migrate** — applies the SDK's shipped migrations, then this app's own, through its own runner.
- **relay** — ships the transactional outbox to the engine.
- **worker** — runs the event and command handlers, including a durable handler.

Later PRs add the entrypoints these processes run (`src/bin/migrate.ts`, `src/relay.ts`,
`src/worker.ts`); this PR ships the package skeleton, configuration and logging only.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KINESIN_EXAMPLE_DATABASE_URL` | yes | — | Postgres connection string for this app's own database. |
| `KINESIN_EXAMPLE_NAMESPACE` | no | `playground_` | Shared prefix so the three processes agree on one run. |
| `KINESIN_EXAMPLE_LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, `error`. |
| `HATCHET_CLIENT_TOKEN` | yes | — | Read by the engine client directly, same as the SDK's own integration lane. |
| `HATCHET_CLIENT_TLS_STRATEGY` | yes | — | Read by the engine client directly. |

## Run it locally

```bash
pnpm hatchet:up
pnpm --filter @kinesin/playground migrate
pnpm --filter @kinesin/playground relay
pnpm --filter @kinesin/playground worker
```
