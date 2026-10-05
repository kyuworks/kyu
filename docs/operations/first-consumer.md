# The first consumer

This page takes a consuming project from nothing to one event published from its own code and one subscriber handling it, in dev. Follow the sections in order. It is written for an engineer in the consuming project who has not read the Kyu repository.

Kyu is the company message bus. The engine under it is Hatchet, self-hosted. Your code talks only to the SDK, `@kyuworks/sdk`; it never imports the Hatchet SDK for bus work ([`AGENTS.md`](../../AGENTS.md), Architecture). The words used here are defined in [`CONTEXT.md`](../../CONTEXT.md).

The worked example is the shop example, [`kyuworks/shop-example`](https://github.com/kyuworks/shop-example). It installs the SDK from npm the way your project will. Each section links the shop file that does the same step.

What you build:

- your project's own engine and bus tenant, which your operator runs from Kyu's template (section 8);
- the outbox tables in your database;
- a relay process that ships outbox rows to the engine;
- one `publish()` call at one service seam, behind a flag;
- one subscription, run by a worker process, that replaces one hand-wired dispatcher.

## 1. What you get, and the rules you accept

You get: messages written inside your own database transaction, so a rolled-back change never sends one; delivery with retries; ordering per key; a failed run you can see and replay; and each run's status by envelope id.

You accept these rules ([`AGENTS.md`](../../AGENTS.md), Delivery rules):

1. **Ids only on the bus.** A message's `data` holds ids and small discriminators. No personal data enters the engine. The handler loads current state from your own database ([design § 7.4](../design/kyu-requirements-and-design.md#74-payload-rule)).
2. **Every handler is idempotent on the envelope id.** Delivery is at least once, so a handler may see the same envelope twice. Make the effect a put of current state, or wrap it in `onceById()` (section 7).
3. **Ordering is per key, declared on the subscription.** There is no global order ([design § 8.4](../design/kyu-requirements-and-design.md#84-ordering)).
4. **A failed run is the dead letter.** A handler throws; it never catches and hides an error. A failed run is visible in the engine dashboard and can be replayed ([design § 9.3](../design/kyu-requirements-and-design.md#93-retries-and-failure)).
5. **The business tenant id travels as metadata.** Every message carries `tenantId`: your customer organisation's id, a uuid, or `null` for a message that belongs to no tenant ([`envelope.ts`](../../packages/schemas/src/envelope.ts), `envelopeSchema`). The bus never reads your tenant data. The handler opens its own tenant-scoped access from that id.

## 2. Install

```bash
pnpm add @kyuworks/sdk zod pg
pnpm add -D @types/pg
```

- `@kyuworks/sdk` brings `@kyuworks/schemas` at the same version. Add `@kyuworks/schemas` yourself only if you import it directly ([`README.md`](../../README.md#install)). The SDK re-exports `defineEvent`, `defineCommand` and the envelope types, so import everything from `@kyuworks/sdk` ([`index.ts`](../../packages/sdk/src/index.ts)).
- `zod` is for your message schemas. A definition takes any Standard Schema; the SDK itself uses zod 4 ([`define.ts`](../../packages/schemas/src/define.ts), `MessageSchema`).
- `pg` is yours. The SDK does not import it: `publish()` and `onceById()` take any client with a `query(text, params)` method, and a `pg` client inside `BEGIN` is one ([`queryable.ts`](../../packages/sdk/src/db/queryable.ts)).
- Node 24. Kyu and the shop build and test on it ([`.nvmrc`](../../.nvmrc)).

pnpm 11 needs two settings in `pnpm-workspace.yaml`, as in the shop's [`pnpm-workspace.yaml`](https://github.com/kyuworks/shop-example/blob/main/pnpm-workspace.yaml):

```yaml
# Take a Kyu release the day it ships; pnpm 11 otherwise refuses a version younger than its minimum release age.
minimumReleaseAgeExclude:
  - '@kyuworks/sdk'
  - '@kyuworks/schemas'
# Lifecycle scripts run only when true. The engine SDK's postinstall is required;
# protobufjs only prints a banner, and without this line pnpm 11 stops with ERR_PNPM_IGNORED_BUILDS.
allowBuilds:
  esbuild: true
  '@hatchet-dev/typescript-sdk': true
  protobufjs: false
```

`esbuild: true` is for a project that runs TypeScript with `tsx`; leave it out if you do not. Compile your code with `tsc`, or run it with `tsx`. The worker snippet in section 7 uses top-level `await`, so your `package.json` needs `"type": "module"`.

## 3. Database

The SDK ships SQL migrations that create three tables in your own database ([`migrations/README.md`](../../packages/sdk/migrations/README.md)):

| Table | Used by |
|---|---|
| `kyu_outbox` | `publish()` writes a row; the relay ships it |
| `kyu_processed` | `onceById()` records each handled envelope id |
| `kyu_paused_tenant` | the relay reads it to hold a paused tenant's rows |

Apply them with **your own migration runner**:

1. Read every `*.sql` file in `MIGRATIONS_DIRECTORY`, which the SDK exports. It points at the `migrations/` folder inside the installed package ([`migrations.ts`](../../packages/sdk/src/migrations.ts)).
2. Apply them in file-name order. Each file once. Each file inside its own transaction, which your runner opens and commits. The files contain no `BEGIN` or `COMMIT` of their own.
3. Run each file as one query with no parameters, because a file holds several statements.
4. Record each file name in your runner's own ledger table.

Today there are five files, from `20260916233209_create_outbox.sql` to `20260924124242_paused_tenant.sql`. A released file never changes; a new SDK version may add a file, and its release notes say which ([ADR](../architecture/adr/20260916-outbox-migrations-are-immutable.md)). Apply a new file before you deploy the SDK version that ships it, or the relay fails with `column ... does not exist` ([`migrations/README.md`](../../packages/sdk/migrations/README.md), Rules).

The shop's runner is a short example to copy: [`src/db/migrate.ts`](https://github.com/kyuworks/shop-example/blob/main/src/db/migrate.ts) (`applyPending`) and [`src/bin/migrate.ts`](https://github.com/kyuworks/shop-example/blob/main/src/bin/migrate.ts).

**Schema.** The statements are not schema-qualified, so the tables land in the first schema on your runner's `search_path`. `publish()` and the relay also use unqualified names, so that schema must be on the `search_path` of every connection that publishes, relays or handles. If your platform exposes tables to client roles over an HTTP API, make sure these three are not exposed.

**Behind a transaction pooler.** Run migrations over a direct connection to the database where you have one. The files use no session state (no `SET`, no advisory lock, no `CREATE INDEX CONCURRENTLY`), and they also apply through a transaction-mode PgBouncer, each file in its own transaction as in step 2: [`pooler.integration.test.ts`](../../packages/sdk/src/db/pooler.integration.test.ts), "applies every migration file to a fresh database through the pooler".

**Grants.** If the role that publishes is not the table owner, give it only what it needs: `INSERT` on `kyu_outbox` for `publish()`, `SELECT, UPDATE` on `kyu_outbox` and `SELECT` on `kyu_paused_tenant` for the relay, `INSERT, SELECT` on `kyu_processed` for `onceById()`, `DELETE, SELECT` on `kyu_outbox` for the prune job (full table in [`migrations/README.md`](../../packages/sdk/migrations/README.md), Grants).

**Retention and audit.** The outbox is a delivery buffer, not your event log or audit trail ([ADR](../architecture/adr/20261002-the-outbox-is-not-the-audit-log.md)); keep your audit record in your own tables, stamped with the envelope `id` and `correlationId`. The SDK never deletes an outbox row by itself. Schedule `pruneOutbox` once a day in your own scheduler (a cron entry, a scheduled machine, a CronJob):

```ts
import { pruneOutbox } from '@kyuworks/sdk'
import { Pool } from 'pg'

const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
try {
  console.log('outbox pruned', await pruneOutbox(db))
} finally {
  await db.end()
}
```

It deletes published, retired and cancelled rows older than 45 days, 1000 rows per statement, and never a pending, scheduled or claimed row. 45 days is the floor: your longest durable wait plus the engine's 30-day retention. If your longest wait is longer than 15 days, pass a larger `olderThanMs`. A smaller one throws unless you pass `allowBelowFloor: true` ([`pruneOutbox.ts`](../../packages/sdk/src/outbox/pruneOutbox.ts)). The SDK has no prune for `kyu_processed`. If you delete old rows there, keep at least as many days as your engine keeps runs (7 in the engine template, 30 in production; [engine guide, Retention](kyu-engine-on-fly.md#retention)), so a replayed run still finds its row.

## 4. Message definitions

Keep every message definition in one module, or one package if several services share them. The producer and the consumer import the same definition ([design § 7.3](../design/kyu-requirements-and-design.md#73-schemas)). The shop's is [`src/messages.ts`](https://github.com/kyuworks/shop-example/blob/main/src/messages.ts).

```ts
import { defineEvent } from '@kyuworks/sdk'
import { z } from 'zod'

// Replace <project> with your project's short name.
export const contactUpdated = defineEvent({
  name: '<project>.contact.updated',
  version: 1,
  data: z.object({ contactId: z.uuid() }),
})
```

- **Name:** `<project>.<aggregate>.<verb>`. Exactly three parts, each lower-case letters, digits or `_`, starting with a letter. Events are past tense (`contact.updated`); commands are imperative (`contact.push`). `defineEvent` throws `MessageDefinitionError` on any other name ([`envelope.ts`](../../packages/schemas/src/envelope.ts), `MESSAGE_NAME_PATTERN`; [`define.ts`](../../packages/schemas/src/define.ts)).
- **Version:** a whole number from 1. A subscription accepts exactly one name, version and kind; a message with another version fails that run without retry ([`subscribe.ts`](../../packages/sdk/src/consume/subscribe.ts), `decodeIncomingEnvelope`). So a breaking change to `data` is a new version, and the subscriber for it is deployed before the producer switches. An added optional field is not a breaking change ([design § 7.2](../design/kyu-requirements-and-design.md#72-naming)).
- **Data:** a JSON object of ids and small discriminators. The schema is checked on publish and again in the subscriber.

## 5. Publish

Publish at **one service seam**: the one function where the change is committed. Write the message in the same transaction as the change.

A process that only publishes, such as your API, uses `createPublisher`. It needs only its database, no engine token ([`README.md`](../../README.md#packages); [`publish.ts`](../../packages/sdk/src/outbox/publish.ts), `createPublisher`). A process that also runs a worker can use `kyu.publish` from `createKyu`; it is the same function.

```ts
import { createPublisher } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { contactUpdated } from './messages.js'

const publisher = createPublisher({ source: '<project>.api' })

export async function updateContact(pool: Pool, input: UpdateContactInput): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('UPDATE contact SET name = $2 WHERE id = $1', [input.contactId, input.name])
    await publisher.publish(client, contactUpdated, { contactId: input.contactId }, {
      tenantId: input.tenantId,
      actorUserId: input.userId,
      correlationId: input.correlationId, // leave out when you have none
    })
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
```

The shop does the same in [`src/producer/placeOrder.ts`](https://github.com/kyuworks/shop-example/blob/main/src/producer/placeOrder.ts) with its `withTransaction` helper in [`src/db/pool.ts`](https://github.com/kyuworks/shop-example/blob/main/src/db/pool.ts).

`publish(tx, definition, data, options)` returns the envelope it wrote ([`publish.ts`](../../packages/sdk/src/outbox/publish.ts)). The options ([`createEnvelope.ts`](../../packages/schemas/src/createEnvelope.ts), `CreateEnvelopeOptions`):

| Option | Required | Value |
|---|---|---|
| `tenantId` | yes | the business tenant's uuid, or `null` |
| `actorUserId` | when a user caused it | the user's uuid |
| `correlationId` | no | a uuid **v7** shared by a whole chain of messages. Left out, it is the envelope's own id |
| `causationId` | no | the envelope id (uuid v7) of the message that caused this one |
| `orgUnitId` | no | a uuid for a sub-division of the tenant |
| `occurredAt` | no | a `Date`; defaults to now |
| `publishAt` | no | a `Date`; the relay holds the row until then |

Fill `actorUserId` whenever a signed-in user made the change. For `correlationId`, pass an id your request already carries only if it is a uuid v7; a random (v4) request id is refused. A message a handler publishes in reply passes `correlationId: ctx.envelope.correlationId` and `causationId: ctx.envelope.id`.

`tx` must be a client inside an open transaction. Passing a `pg.Pool` is a type error ([`queryable.ts`](../../packages/sdk/src/db/queryable.ts)).

What happens:

- **Commit:** the row is durable before anything can act on it. The relay ships it on its next tick.
- **Rollback:** the row is gone and nothing is ever delivered.
- **Bad input:** `MessageDataError` (data does not match the schema), `EnvelopeOptionsError` (for example a `tenantId` that is not a uuid) or `RangeError` (an invalid `publishAt`) is thrown before anything is written, so your `catch` rolls the transaction back.

## 6. Relay

The relay is a small process that runs beside your project's other processes. Each tick it claims due rows from `kyu_outbox`, pushes them to the engine grouped by message name, and marks them published. It reads `kyu_outbox` and `kyu_paused_tenant`, and writes only `kyu_outbox` ([design § 8.3](../design/kyu-requirements-and-design.md#83-relay)). Run **one per project per environment**. A project with exactly one long-lived process may start it inside that process instead.

```ts
import { createHatchetClient, createKyu } from '@kyuworks/sdk'
import { Pool } from 'pg'

const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
db.on('error', (error) => console.error('relay: idle connection dropped', error.message))

const kyu = createKyu({ hatchet: createHatchetClient(), source: '<project>.relay' })
const relay = kyu.startRelay({
  db,
  workerId: `<project>-relay-${process.pid}`,
  onError: (error) => console.error('relay:', error.message),
})

// Rejects only when the database handle can never recover; the supervisor restarts the process.
relay.closed.catch(() => process.exit(1))

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void relay.stop().then(() => db.end()).then(() => process.exit(0))
  })
}
```

The shop's version is [`src/relay.ts`](https://github.com/kyuworks/shop-example/blob/main/src/relay.ts).

- **Database handle:** a small `pg.Pool` of its own (`max: 1`), not your application's pool and not a single `pg.Client`. Every relay statement stands alone, so a pool is safe and replaces a dropped connection on the next tick. Attach `pool.on('error')`, or an idle connection that drops takes the process down ([`README.md`](../../README.md#packages); [`queryable.ts`](../../packages/sdk/src/db/queryable.ts), `RelayQueryable`).
- **Transaction pooler:** the relay, `publish()`, `onceById()` and tenant pause work through a transaction-mode pooler. The relay holds no session state and takes no advisory lock; its claim is a stamp on the row, not a lock held by the connection ([design § 8.3](../design/kyu-requirements-and-design.md#83-relay)). [`pooler.integration.test.ts`](../../packages/sdk/src/db/pooler.integration.test.ts) runs each of them through PgBouncer 1.25 in transaction mode, with its prepared-statement support turned off, on every Kyu change. Another pooler (Supavisor, or your cloud provider's) is not tested here; check yours in your dev environment before you rely on it.
- **`workerId`:** unique per running process ([`relay.ts`](../../packages/sdk/src/relay/relay.ts), `RelayOptions`).
- **Supervision:** restart it on exit. On `relay.closed` rejecting (`RelayConnectionLostError`), exit non-zero. On SIGTERM, call `relay.stop()`. A relay killed without `stop()` leaves its claimed rows for `staleClaimMs` (default 5 minutes) before another relay takes them; the shop sets 30 seconds.
- **Environment:** the SDK reads no environment variable itself. The engine client reads `HATCHET_CLIENT_TOKEN`, `HATCHET_CLIENT_API_URL`, `HATCHET_CLIENT_HOST_PORT`, `HATCHET_CLIENT_TLS_STRATEGY` and `HATCHET_CLIENT_NAMESPACE` (section 8; the shop's [README](https://github.com/kyuworks/shop-example/blob/main/README.md#environment-variables) lists them). Your own variable gives the database URL.
- **Defaults:** up to 100 rows per tick, a poll every 250 ms when idle, a backoff up to 30 seconds after a failed push ([`relay.ts`](../../packages/sdk/src/relay/relay.ts)).
- **Pruning:** the relay never deletes a row. Schedule the prune job from [section 3](#3-database).

**Lag and backlog.** Run these against your database ([design § 8.5](../design/kyu-requirements-and-design.md#85-operations) has the full set). Alert when the oldest pending row is older than 60 seconds:

```sql
SELECT min(created_at) AS oldest_pending FROM kyu_outbox WHERE published_at IS NULL AND dead_at IS NULL AND cancelled_at IS NULL AND publish_at <= now() AND NOT EXISTS (SELECT 1 FROM kyu_paused_tenant p WHERE p.tenant_id = kyu_outbox.tenant_id);
```

Rows the engine keeps refusing (push failures retry for ever):

```sql
SELECT id, name, attempts, last_error FROM kyu_outbox WHERE published_at IS NULL AND dead_at IS NULL AND cancelled_at IS NULL AND publish_at <= now() AND attempts > 10;
```

Retired rows, whose envelope never parsed and will never ship; alert on any:

```sql
SELECT id, name, attempts, last_error, dead_at FROM kyu_outbox WHERE dead_at IS NOT NULL ORDER BY dead_at DESC;
```

## 7. Subscribe

Replace **one** hand-wired dispatcher with **one** subscription.

A good first seam is an edit-triggered push to an external system: a record changes, and its new state must reach another system. It needs ordering per record and needs the push in flight to be cancelled when a newer edit arrives, and both are one line on the subscription. (The design maps this pattern to a command; an event, as here, lets a second subscriber join later without touching the producer. Either works.)

```ts
import { NonRetryableError } from '@kyuworks/sdk'
import type { Kyu, Subscription } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { contactUpdated } from './messages.js'

export function pushContactSubscription(kyu: Kyu, pool: Pool): Subscription {
  return kyu.subscribe(contactUpdated, {
    name: 'push-contact',
    // One run per contact at a time; a newer edit cancels the push still running.
    concurrency: { key: 'input.data.contactId', maxRuns: 1, strategy: 'cancel_in_progress' },
    retries: 5,
    backoff: { factor: 2, maxSeconds: 300 },
    handler: async (ctx) => {
      const { tenantId } = ctx.envelope
      if (tenantId === null) throw new NonRetryableError(`push-contact: envelope ${ctx.envelope.id} has no tenantId`)
      const contact = await loadContact(pool, tenantId, ctx.envelope.data.contactId)
      if (contact === null) return
      // A put of the current state: sending it twice changes nothing.
      await pushContact(contact, { signal: ctx.signal })
    },
  })
}
```

**The handler** receives `ctx` ([`handlerContext.ts`](../../packages/sdk/src/consume/handlerContext.ts)):

- `ctx.envelope` — already decoded, with `data` checked against your definition ([`subscribe.ts`](../../packages/sdk/src/consume/subscribe.ts));
- `ctx.signal` — aborts when the engine cancels this run, including a `cancel_in_progress` cancel. Pass it to your HTTP client so a stale push stops;
- `ctx.retryCount`, `ctx.runId`, `ctx.logger`, `ctx.metadata`.

Throw to retry, up to `retries` with `backoff`. Throw `NonRetryableError` for a condition no retry can fix, such as a 400 or 404 answer that will not change on retry (408 and 429 are retryable), or a record that no longer exists. Either way an exhausted run is a failed run, which is the dead letter.

**The idempotency guard.** A push of current state is idempotent by itself. A handler that writes to your database wraps the write in `onceById` inside the handler's own transaction. `withTransaction` below is your project's own helper: `withTransaction(pool, fn)` opens a client, runs `BEGIN`, calls `fn(client)`, then `COMMIT`s, or `ROLLBACK`s and rethrows if `fn` throws. The shop's is [`src/db/pool.ts`](https://github.com/kyuworks/shop-example/blob/main/src/db/pool.ts).

```ts
await withTransaction(pool, (tx) =>
  kyu.onceById(tx, ctx.envelope.id, 'record-contact-push', async () => {
    await tx.query('UPDATE contact SET pushed_at = now() WHERE id = $1', [ctx.envelope.data.contactId])
  }),
)
```

`onceById(tx, envelopeId, handlerName, fn)` inserts `(envelopeId, handlerName)` into `kyu_processed` and runs `fn` only if the row is new; it returns `{ ran: true, result }` or `{ ran: false }`. If `fn` throws, the transaction rolls back with the processed row, so a retry runs it again ([`onceById.ts`](../../packages/sdk/src/outbox/onceById.ts)). The handler name is part of the key: never rename it, or every envelope is handled again ([`migrations/README.md`](../../packages/sdk/migrations/README.md)). The shop's [`src/handlers/sendInvoice.ts`](https://github.com/kyuworks/shop-example/blob/main/src/handlers/sendInvoice.ts) is a full example.

**The ordering key** is a CEL expression over the message ([`concurrency.ts`](../../packages/sdk/src/consume/concurrency.ts)):

| Need | `concurrency` |
|---|---|
| One at a time per record, in publish order | `{ key: 'input.data.contactId', maxRuns: 1 }` (`strategy` defaults to `'fifo'`) |
| Only the newest matters | `strategy: 'cancel_in_progress'` on the same key |
| Drop a new one while one runs | `strategy: 'cancel_newest'` |
| One run per business tenant, tenants taking turns | `{ key: TENANT_CONCURRENCY_KEY, maxRuns: 1, strategy: 'round-robin' }` |

`TENANT_CONCURRENCY_KEY` fails any message whose `tenantId` is `null`. Other options: `rateLimit`, and `scheduleTimeout` (how long a run may wait for a free slot; the engine's default is 5 minutes) ([`taskOptions.ts`](../../packages/sdk/src/consume/taskOptions.ts)). A subscription `name` is lower-case letters, digits, `-` or `_`, starting with a letter.

**The worker process:**

```ts
import { createHatchetClient, createKyu } from '@kyuworks/sdk'
import { Pool } from 'pg'
import { pushContactSubscription } from './subscriptions/pushContact.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
pool.on('error', (error) => console.error('worker: idle connection dropped', error.message))

const kyu = createKyu({ hatchet: createHatchetClient(), source: '<project>.worker' })
const worker = await kyu.worker('<project>-worker', {
  subscriptions: [pushContactSubscription(kyu, pool)],
  slots: 5,
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void worker.stop().then(() => pool.end()).then(() => process.exit(0))
  })
}

void worker.start() // resolves only when the worker stops
await worker.waitUntilReady()
```

The shop's version is [`src/worker.ts`](https://github.com/kyuworks/shop-example/blob/main/src/worker.ts) ([`worker.ts`](../../packages/sdk/src/consume/worker.ts) in the SDK).

- **Slots:** how many runs this process handles at once. Unset, the engine allows 100; set it, and give the database pool at least that many connections. The shop uses 5.
- **Pool:** one worker process for the first slice, as a separate entrypoint of the same image as your API. Later, `serves: ['push-contact']` splits subscriptions across processes.
- **Start the worker before the first message is published.** The engine creates a run only for a subscription some running worker has registered, and it does not back-fill one registered later ([design § 12](../design/kyu-requirements-and-design.md#12-deployment-and-operations), Worker pools).
- **A command has exactly one subscriber.** `kyu.worker` refuses two in one process; across processes it is your job.

## 8. Engine access

Your project runs its own engine. Kyu runs none ([ADR](../architecture/adr/20261006-each-producer-application-runs-its-own-engine.md)). Your project's operator, the person who holds its Fly organisation and its password manager, runs the engine and its bus tenants from the [engine guide](kyu-engine-on-fly.md). The engine's addresses and tokens live in that password manager; this page names none.

1. **Engine.** One per environment. If your project has none in dev yet, your operator stands one up with [the guide's First deploy](kyu-engine-on-fly.md#first-deploy). Until then, use a local engine (end of this section).
2. **Bus tenant.** Each project gets its own bus tenant (a Hatchet tenant) per environment. Your project never shares one with another project ([design § 6.2](../design/kyu-requirements-and-design.md#62-bus-tenants-and-tokens)). Your operator creates yours with [the guide, A bus tenant for each project](kyu-engine-on-fly.md#a-bus-tenant-for-each-project), names it `<project>-dev`, records its id, and puts its worker token in your project's secret store (item 3). Do not use the tenant the engine created at boot: its id is the same on every engine. Set your own namespace as well (item 5).
3. **Worker token.** Your operator mints it, or an engineer the operator has given an SSH certificate for the engine's Fly organisation: `bash infra/hatchet/fly/token.sh -a <engine-app> --tenant-id <your-bus-tenant-id>`, from your copy of the template ([`token.sh`](../../infra/hatchet/fly/token.sh); [guide, Who does what](kyu-engine-on-fly.md#who-does-what)). The token goes straight into your project's secret store. It expires 90 days after it is minted; mint a new one before then ([guide, A bus tenant for each project](kyu-engine-on-fly.md#a-bus-tenant-for-each-project), sub-step 5). An agent never mints, reads or prints a token. Never commit it or log it.
4. **The three variables** every process that talks to the engine needs (the relay, the worker, anything that reads run outcomes):

   | Variable | Value |
   |---|---|
   | `HATCHET_CLIENT_TOKEN` | the worker token |
   | `HATCHET_CLIENT_API_URL` | your engine's HTTPS address, `https://<engine-app>.fly.dev` |
   | `HATCHET_CLIENT_HOST_PORT` | your engine's gRPC address and port, `<engine-app>.fly.dev:7077` |

   Leave `HATCHET_CLIENT_TLS_STRATEGY` unset against a deployed engine; it defaults to `tls`. Set it to `none` only for a local engine. A process that only publishes needs none of these.
5. **Namespace.** Set `HATCHET_CLIENT_NAMESPACE` (or pass `namespace` to `createHatchetClient`) to the same value in the relay and every worker. The engine prefixes every message name and subscription with it, lower-cased, with a trailing `_`, so a relay and a worker with different namespaces never meet.

For a first try without an engine of your own, run the engine on your machine from a Kyu checkout: `pnpm hatchet:up`, then `export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/token.sh)"` and `export HATCHET_CLIENT_TLS_STRATEGY=none` ([`README.md`](../../README.md#quick-start)).

## 9. Flag and rollout

Put the slice behind your project's own flag, read at the seam. Kyu has no flag of its own.

- Flag on: the seam publishes the event and does **not** call the old dispatcher or start the old fixed delay.
- Flag off: the old path runs and nothing is published.
- Never both for the same change, or the external system gets two pushes.

Roll out in this order:

1. Have your engine and bus tenant in dev (section 8).
2. Apply the migrations (section 3).
3. Deploy the relay (section 6).
4. Deploy the worker and check that it appears in the engine dashboard (section 7).
5. Turn the flag on for one business tenant in dev, then for all of dev.

Before you turn it on, write down how the old path behaves at that seam: the fixed delay, and the in-process code that calls the dispatcher. The slice is done when both are gone from that seam ([design Phase 3](../design/kyu-requirements-and-design.md#phase-3-first-consumer-one-to-two-weeks)). Measure, before and after:

- **Time to effect:** from the change's commit to the push finishing. After: `finishedAt` from `kyu.runs.forEnvelope(envelope.id)` minus the envelope's `occurredAt` ([`runOutcomes.ts`](../../packages/sdk/src/consume/runOutcomes.ts), `RunOutcome`).
- **Failures:** runs with `status: 'failed'`, and rows in the retired-rows query.
- **Outbox lag:** the oldest-pending query in section 6.
- **Duplicates and coalescing:** pushes the external system received twice; runs ending `cancelled` because a newer edit replaced them.

Turning the flag off stops new messages. Messages already in the outbox are still delivered, so leave the relay and worker running until the outbox and the engine are both drained:

- No row is pending: the oldest-pending query in section 6 returns `null`, and the scheduled-rows query ([design § 8.5](../design/kyu-requirements-and-design.md#85-operations), rows with `publish_at > now()`) returns no rows. The oldest-pending query skips future `publish_at` rows and paused tenants' rows, so it alone is not enough.
- The engine has nothing in flight: a row is marked published once the engine accepts it, while its run may still be queued. The engine dashboard's run list for the subscription shows no queued or running run, or `kyu.runs.forEnvelope(id)` returns only `completed`, `failed` or `cancelled` outcomes ([`runOutcomes.ts`](../../packages/sdk/src/consume/runOutcomes.ts), `RunOutcome`).

## 10. Checks

See each delivery rule hold in dev before you widen the flag. Each one also has an SDK test that proves it on every Kyu change.

| Rule | How to see it in dev | SDK test |
|---|---|---|
| A rolled-back publish never arrives | In a script: `BEGIN`, `publish()`, `ROLLBACK`. Then `SELECT count(*) FROM kyu_outbox WHERE id = '<envelope id>'` is 0 and `kyu.runs.forEnvelope('<envelope id>')` returns `[]` | [`publish.integration.test.ts`](../../packages/sdk/src/outbox/publish.integration.test.ts): "a rolled-back transaction leaves no outbox row" |
| A redelivery is idempotent | Replay a completed run from the engine dashboard (a local engine's dashboard is at `http://localhost:8888` after `pnpm hatchet:up`; the seeded admin sign-in is in the header comment of [`infra/hatchet/compose.yaml`](../../infra/hatchet/compose.yaml)). The external system shows no second change, and `kyu_processed` still has one row for that envelope id and handler | [`onceById.integration.test.ts`](../../packages/sdk/src/outbox/onceById.integration.test.ts): "runs the body once across repeated calls for the same envelope id and handler" |
| The tenant id reaches the handler unchanged | Log `ctx.envelope.tenantId` in the handler and compare it with the `tenantId` you published. The SDK fails a run whose metadata tenant and envelope tenant disagree | [`subscribe.integration.test.ts`](../../packages/sdk/src/consume/subscribe.integration.test.ts): "reaches the handler with the tenant id unchanged (flow 5)" |
| Ordering holds per key | Make three quick edits to one record. With `fifo`, the handler logs them in publish order. With `cancel_in_progress`, the earlier runs end `cancelled` and the external system holds the last edit | [`subscribe.integration.test.ts`](../../packages/sdk/src/consume/subscribe.integration.test.ts): "preserves publish order per key (flow 7)" and "lets only the newest complete (flow 8)" |

## 11. Not in the first slice

| Not now | Where it is written up |
|---|---|
| Durable handlers (`kyu.durable`, `sleepFor`, `waitFor`) | available; [`README.md`](../../README.md) and [design § 9.5](../design/kyu-requirements-and-design.md#95-timers-and-correlation) |
| Integration pools and `ctx.emit()` | proposed, not in the SDK yet: [ADR](../architecture/adr/20260925-handlers-may-emit-straight-to-the-engine.md) |
| The writer pool | proposed, same ADR; [design § 12](../design/kyu-requirements-and-design.md#12-deployment-and-operations), Pool layout |
| Alerts on failed runs | optional, on your engine: your operator turns on the engine's own Slack alerts ([guide, Turning on failure alerts](kyu-engine-on-fly.md#turning-on-failure-alerts)). Kyu runs no alerting |
| Alerts on outbox lag | not in the SDK; run the section 6 queries from your own monitoring |
| Crons, tenant pause, run cancel | available; [`README.md`](../../README.md) |
| Inbound webhooks | [design § 6.1](../design/kyu-requirements-and-design.md#61-components) |

Questions or a gap in this page: open an issue in [`kyuworks/kyu`](https://github.com/kyuworks/kyu/issues).
