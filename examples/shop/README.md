# Kyu shop

A small app that uses `@kyuworks/sdk` the way a real project would. It sells nothing real; the
messages are named `shop.*` as a neutral stand-in.

Four processes share one Postgres database and one Hatchet engine:

- **migrate** — applies the SDK's shipped migrations, then this app's own, through its own runner.
- **relay** — ships the transactional outbox to the engine; the sidecar shape a project uses by default.
- **worker** — runs the event and command handlers.
- **ui** — the web app on `KYU_SHOP_UI_PORT`; serves the pages and the JSON routes, and reads run outcomes from the engine.

`worker` runs `record-order` and `audit-order` (two subscribers on `shop.order.placed`),
`send-invoice` (a FIFO-per-order command handler, `shop.invoice.send`), `watch-shipping`, a
durable handler that sleeps five seconds and then waits for the correlated `shop.order.shipped`
event, and `record-shipment`, a plain subscriber on that same `shop.order.shipped` event that
records `shop_order.shipped_at`. Killing and restarting the worker while a `watch-shipping` run is
parked in that wait proves the run resumes in the new process, not the one that started it.
`watch-shipping` no longer writes `shipped_at` itself; it only reports whether the order shipped
in time, so a shipment that arrives after its wait has timed out still reaches the shipped stage.

A worker stopped while `watch-shipping`'s body is still executing fails that attempt, and the
engine retries it on the next worker to start. A worker stopped once the run is parked in its
wait hands the wait to the next worker directly, with no failed attempt in between.

`worker` also runs `run-workflow`, a durable handler that reads a workflow definition from the
shop's own tables (below) and walks its steps — a delay, a branch on whether the order has
shipped, and a staff notification — and `notify-staff`, a plain command handler that reads the
wording for that notification from the pinned version and writes a `shop_handler_log` row, the
same way every other handler here records what it did.

The relay runs on a `pg.Pool` of one connection, not a bare `pg.Client`: the relay never opens a
transaction, so a pool is safe here. The normal path when Postgres drops the connection is a
`db-connection-dropped` log line, then pg reconnecting by itself on the relay's next poll — no
restart needed. `connection-lost` (exit code 1) is the fallback for a handle that can never
recover — a bare `pg.Client`, or this pool after something has called `.end()` on it — and only
then does `relay.closed` reject with a `RelayConnectionLostError`. A real deployment runs the
relay under a supervisor that restarts it on that exit — `pnpm --filter @kyuworks/shop relay`
alone does not.

A relay stopped by SIGTERM releases its claimed rows before exiting. A relay killed without
SIGTERM (a crash, a supervisor's SIGKILL) leaves its claims stale for 30 seconds before another
relay takes them over.

## Producer CLI

```bash
pnpm --filter @kyuworks/shop publish-cli place-order --tenant <uuid> [--customer <uuid>]
pnpm --filter @kyuworks/shop publish-cli ship-order --tenant <uuid> --order <uuid> [--carrier <name>]
```

Each command commits one transaction and prints the ids it created as one JSON line. A missing
`--tenant` (or `--order` for `ship-order`) prints an error and exits 1; an unknown command does
the same. The CLI's `--tenant` is unrelated to the demo tenant the web routes use (below); it
lets a script exercise the bus under any tenant id.

The CLI needs no engine credentials. It builds a publisher with `createShopPublisher()`
(`src/kyu.ts`), which calls the SDK's `createPublisher({ source })`: publishing writes one
`kyu_outbox` row inside the CLI's own transaction and stops there. Only `relay`, `worker` and `ui`
build an engine client, and only they need `HATCHET_CLIENT_TOKEN`.

## The catalogue, orders and the demo tenant

`migrations/0002_shop.sql` adds `shop_product` (a fixed six-row catalogue, seeded with literal
ids so a product id the browser sends back always matches) and `shop_order_line` (one row per
line, its unit price copied from the catalogue at order time so a later price change cannot
rewrite an old order's total). `shop_order` gains `paid_at` (set the moment the order is placed;
there is no real payment provider, only a note in the UI that it is simulated) and `total_cents`.

The web routes (`POST /orders`, `POST /shipments`, `POST /invoices`, `GET /products.json`,
`GET /orders.json`) never take a tenant id from the client — there is no sign-in, so every one of
them uses the single `DEMO_TENANT_ID` constant in `src/shop.ts`. The producer CLI above is
unaffected: it still takes `--tenant` and can exercise any tenant.

`POST /orders` takes `{ customerId?, lines: [{ productId, quantity }] }`, at least one line and at
most twenty, and returns `{ orderId, invoiceId, totalCents, orderPlacedEnvelopeId,
sendInvoiceEnvelopeId }`. An order naming a product id that is not in the catalogue commits
nothing and publishes nothing — the whole transaction rolls back. `POST /invoices` takes
`{ orderId, invoiceId? }`; a missing `invoiceId` sends the command for a fresh id with no
matching `shop_invoice` row, the simulated fault that gives the Bus page a dead letter to show.

## The workflow tables

`migrations/0004_shop.sql` adds four tables that hold a user-defined workflow as data, following
`docs/architecture/adr/20260920-workflow-definitions-run-through-one-interpreter.md`:
`shop_workflow_definition` (one row per definition, at most one `enabled` per tenant),
`shop_workflow_version` (one row per saved version, its steps stored as JSON against
`src/workflow/definition.ts`'s schema), `shop_workflow_run` (one row per run, pinned to the version
it started with) and `shop_workflow_step_log` (one row per step a run has finished).
`migrations/0005_shop.sql` seeds one enabled definition for the demo tenant, so placing an order on
the shop's checkout page starts a run, visible on the Bus page under `run-workflow` and
`notify-staff`.

When an order is placed, `placeOrder` looks for the one workflow enabled for that tenant. If there
is one, it publishes `shop.workflow.triggered` in the same transaction as the order, carrying a new
run id, the definition id, the pinned version id and the order id — ids only, never a step's
authored text. The run id is a uuid v7 minted at that point and is also the message's correlation
id.

`run-workflow`, a durable handler, subscribes to that one message and walks the pinned version's
steps: `src/workflow/definition.ts`'s `parseWorkflowDefinition` is the trust edge, run every time a
version is loaded, never cached, so a stored definition that has drifted from the schema is caught
there. A delay under 60 seconds parks the run in `ctx.sleepFor`; a delay of 60 seconds or more writes
the step's ledger row and republishes the trigger message with `publishAt` set to the wake time and
`resumeStepId` set to the next step, in one transaction, and the run ends — the relay ships the row
at its time and a new run resumes at that step. A branch step reads whether the order has shipped —
the one condition this interpreter knows — and writes the exit it chose to `shop_workflow_step_log`
in the same transaction as the decision; a replay reads that exit back instead of asking the order
again, because only `sleepFor` itself replays from the durable log, not an ordinary database read. A
notify step publishes `shop.staff.notify` (ids only) for `notify-staff` to pick up, which reads the
wording out of the pinned version by step id and writes a `shop_handler_log` row. Every step's effect
— the ledger row, and for a notify step the published command — runs inside `kyu.onceById`, keyed on
the run id and the step id (a step id may itself be `"start"`; the run's own start guard uses a
separate key so the two can never collide), so a step that runs a second time after a restart changes
nothing. `run-workflow` fixes `executionTimeout` at one hour. Pinning the version also keeps two
workers' recorded sleeps identical, which the durable engine requires. See
`docs/architecture/adr/20260920-workflow-definitions-run-through-one-interpreter.md` for the design
this follows.

## Web page

A Vite + React app under `web/`, built to `dist/web/` by `pnpm --filter @kyuworks/shop build`
(`tsc -b && vite build`) and served from there by the `ui` process:

```bash
pnpm --filter @kyuworks/shop build
pnpm --filter @kyuworks/shop ui
```

Open `http://127.0.0.1:3333` (`KYU_SHOP_UI_PORT` to change the port). For hot reload during
development, run `pnpm --filter @kyuworks/shop web:dev` instead: it proxies the JSON and POST
routes to the `ui` process, which must already be running.

`web/` uses bundler module resolution, so its own relative imports carry no `.js` extension —
unlike `src/`, which is NodeNext and always does. Do not mix the two styles inside `web/`.
`typecheck:tests` type-checks `web/` too, through `tsconfig.web.json`. `web/index.html` is not
picked up by `pnpm format` or by the changed-file selector; it is not worth a glob for one file.

Styling is Tailwind CSS v4 through `@tailwindcss/vite`, with HeroUI v3 components and Heroicons.
The entry is `web/theme.css`, which imports only the HeroUI component stylesheets the pages
actually use. Light and dark follow the OS: an inline script in `web/index.html` sets the class
before first paint, and `web/lib/theme.ts`'s `watchSystemTheme` keeps it in sync afterwards from
a guarded effect in `App.tsx`. Nothing is persisted and there is no HeroUI provider. Every page's
own typography and layout come from Tailwind utilities; there is no separate hand-written stylesheet.

`/` is the Shop page: a grid of product cards from `GET /products.json`, each with a quantity
stepper (increment and decrement buttons either side of the number) and an "Add to order" button,
next to a cart summary with the running total. `/checkout` shows the cart's lines and total and
one button, **Pay and place order** — there is no payment
provider, so pressing it writes the order with `paid_at = now()` in the same transaction and
posts to `POST /orders`. On success the page shows the order id, the total, and the two envelope
ids, with a link to `/orders`. The cart is kept in `localStorage` under `kyu.shop.cart` so it survives the full page
load a real `<a href>` nav makes; the browser's own customer id lives under
`kyu.shop.customerId`. Both are read and written through a try/catch — a private window throws
on access, and a storage failure must never break the page.

A request that fails after the server has already committed the order still shows a checkout
error — the browser has no way to tell "the write failed" from "the response never arrived" — and
pressing pay again places a second order. The bus is at-least-once and this demo does not
deduplicate; a real storefront would show the order it already has instead of retrying blind.

`/orders` lists the newest 50 orders for the demo tenant (`ORDER_HISTORY_LIMIT`), not every order,
newest first, from `GET /orders.json`: each card shows the order's short id, its lines with
quantities, unit prices and line amounts, its total, a "yours" badge when the order's customer id
matches this browser's, and a three-step timeline — placed, invoice sent, shipped — with "timed
out" replacing the last step's label when `watch-shipping`'s correlated wait ran out instead of
hearing back. The page refreshes every 5 seconds through `web/lib/usePolledJson.ts`, the one
polling hook `/bus` and `/warehouse` also use: one request in flight at a time, and a failed
refresh leaves the last good list on screen under the status line. Each order also carries
**Resend invoice (simulated fault)**: it posts to `POST /invoices`
with no invoice id, so the server sends the command for one with no matching `shop_invoice` row.
`handleSendInvoice` cannot find it, throws, and the run becomes a dead letter — the same failure
the `/bus` page's `send-invoice` column is there to show.

`/warehouse` lists the same `GET /orders.json` orders that have not reached the shipped stage,
oldest first — a worklist, not a shop view. Each row shows the order's short id, its lines in one
line of text, its total, and a carrier input defaulted to `Speedy` next to a **Ship** button
posting to `POST /shipments`. There is no new read model: the page reads the same document
`/orders` does and filters it. A shipped row leaves the worklist on the next 5-second refresh, and
`/orders` shows that order's stage as _shipped_ once `record-shipment` records it. A shipment that
arrives after `watch-shipping`'s wait has already timed out still marks the order shipped — the
run that timed out is not a dead end for the business process.

A failed run — like the resend-invoice fault above — is a dead letter: it is never retried
silently, it is alerted on, and it can be replayed from the Hatchet dashboard linked at the top of
`/bus`, `/orders` and `/warehouse`. A shipment naming an order this tenant does not have is a dead
letter too, under `record-shipment`.

`/bus` is a React page now: it draws the producer, the outbox, and one column per subscription
in registry order, refreshed every 5 seconds. Outbox stages — published, waiting for relay,
scheduled, shipped and retired — come from `kyu_outbox`. A row whose envelope does not match the message
contract is retired by the relay after three tries: it is counted under **retired**, not under
waiting for relay, so the waiting number is not stuck above zero for ever. Each subscription's
queued, running, done, failed and
cancelled counts come from the engine, through the SDK's `runs.forEnvelope`, one call per
message over the newest 200 subscribed messages. `watch-shipping`'s parked count and its
shipped/timed-out split under "done" come from `shop_handler_log`. A legend under the diagram
explains every term. The ui process now needs a reachable engine to serve `/bus.json`; the page
shows a status line instead of stale counts when it is down, and the last good counts stay on
screen rather than being wiped by a failed refresh.

### Bundle size

Tracked across issue #81 (Tailwind v4, HeroUI v3, Heroicons), `pnpm --filter @kyuworks/shop build`:

|                                             | JS raw    | JS gzip   | CSS raw  | CSS gzip |
| ------------------------------------------- | --------- | --------- | -------- | -------- |
| `main` (before #81)                         | 325.69 kB | 97.61 kB  | 6.38 kB  | 1.65 kB  |
| after PR 3 (Warehouse, ship form, shell)    | 476.51 kB | 145.08 kB | 81.53 kB | 10.10 kB |
| after PR 4 (Bus page, `styles.css` deleted) | 478.05 kB | 145.23 kB | 77.62 kB | 9.58 kB  |

## Environment variables

| Variable                      | Required                       | Default           | Purpose                                                                                                                  |
| ----------------------------- | ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `KYU_SHOP_DATABASE_URL`       | yes                            | —                 | Postgres connection string for this app's own database.                                                                  |
| `KYU_SHOP_NAMESPACE`          | no                             | `shop_`           | Shared prefix so the three processes agree on one run.                                                                   |
| `KYU_SHOP_LOG_LEVEL`          | no                             | `info`            | One of `debug`, `info`, `warn`, `error`.                                                                                 |
| `KYU_SHOP_WATCH_TIMEOUT`      | no                             | `3m`              | `watch-shipping`'s correlated wait timeout; an h/m/s duration string.                                                    |
| `KYU_SHOP_RELAY_BATCH_SIZE`   | no                             | the SDK's default | Read only by `relay`; rows claimed per tick.                                                                             |
| `KYU_SHOP_SLOTS`              | no                             | `5`                | Read only by `worker`; how many plain handler runs it takes at once.                                                     |
| `KYU_SHOP_DURABLE_SLOTS`      | no                             | `5`                | Read only by `worker`; how many durable runs it takes at once. A durable run holds its slot for the whole wait.          |
| `KYU_SHOP_UI_PORT`            | no                             | `3333`            | Read only by `ui`; the local port the web page binds to.                                                                 |
| `HATCHET_CLIENT_TOKEN`        | for `relay`, `worker` and `ui` | —                 | Read by the engine client directly, same as the SDK's own integration lane. `migrate` and `publish-cli` never build one. |
| `HATCHET_CLIENT_TLS_STRATEGY` | for `relay`, `worker` and `ui` | —                 | Read by the engine client directly.                                                                                      |

The namespace is a prefix; the engine lowercases it and gives it a trailing underscore if one
is missing.

## Run it locally

```bash
pnpm hatchet:up
export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/token.sh)"
export HATCHET_CLIENT_TLS_STRATEGY=none
pnpm --filter @kyuworks/shop build
pnpm --filter @kyuworks/shop migrate
pnpm --filter @kyuworks/shop relay
```

`relay` blocks in its own terminal, polling the outbox until you stop it with Ctrl-C. Run
`worker` in a second terminal, with the same environment variables exported there too, then run
the CLI in a third:

```bash
pnpm --filter @kyuworks/shop worker
pnpm --filter @kyuworks/shop publish-cli place-order --tenant <uuid>
```

`HATCHET_CLIENT_TOKEN` and `HATCHET_CLIENT_TLS_STRATEGY` are needed by `relay`, `worker` and `ui`,
not by `migrate` and not by `publish-cli`.

To see the retired bucket move, insert a row the relay cannot read. `envelope` here is missing
every field but `name`; `name` must match `envelope->>'name'` (the table checks it). A retired
row with no `source` is counted under a producer named `(unknown)`. Setting `dead_at`
yourself skips the relay's three-try countdown.

```sql
INSERT INTO kyu_outbox (id, name, envelope, dead_at, attempts, last_error)
VALUES (gen_random_uuid(), 'shop.order.legacy', '{"name":"shop.order.legacy"}'::jsonb, now(), 3, 'envelope: invalid');
```

Reload `/bus`: a **Producer: (unknown)** box appears, **retired** goes up by one and **waiting for relay** does not move. Delete the row
when you are done. Nothing in the shop deletes retired rows; the SDK's `pruneRetired` does, when
a consumer schedules it.

## Failure and load harness

The harness runs the shop under injected faults and checks two things after every scenario: no
effect was lost, and no effect happened twice.

```bash
pnpm --filter @kyuworks/shop build
export KYU_SHOP_DATABASE_URL=postgresql://hatchet:hatchet@localhost:15432/kyu_shop_harness
export KYU_SHOP_NAMESPACE=harness_
export HATCHET_CLIENT_TLS_STRATEGY=none
export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/token.sh)"
pnpm --filter @kyuworks/shop migrate
pnpm --filter @kyuworks/shop harness --scenario all --size smoke --out report.json
```

`--size smoke` is the default and takes a few minutes. `--size report` uses the full numbers from
the written proof and takes longer; the time per scenario is in `docs/proofs/`.

The harness empties the shop and bus tables in the database you point it at, before and after
every scenario. Point it at its own database. It starts and stops its own relay and worker
processes and never touches Docker.

The harness is not run by CI. It is run by hand to produce the proof under `docs/proofs/`. This
first pull request ships the runner and four crash scenarios (a relay killed between pushing and
marking a message published, a worker killed mid-step, a worker killed while parked, the relay's
database connection dropped); a second pull request adds the engine outage, load, long-delay and
cancel scenarios and the report.

## Engine hygiene

Each test run registers workflows and a concurrency strategy under a random namespace that the
engine never removes. Run `pnpm hatchet:down -v` then `pnpm hatchet:up` periodically to clear
the accumulated registrations and keep the local engine responsive.
