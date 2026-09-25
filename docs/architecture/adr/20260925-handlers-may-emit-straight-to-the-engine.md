# Handlers may emit straight to the engine

**Status:** proposed
**Date:** 2026-09-25
**Parent:** [#217](https://github.com/Camba-nz/kyu/issues/217)
**This is not** a decision about the relay's own connection, how the API process is deployed, how the CRM issues and rotates its service tokens, or how an integration machine obtains or renews its short-lived CRM token.

An integration handler announces its outcome with `ctx.emit()`, which pushes straight to the engine. This is a second publish path beside `publish()`, with weaker guarantees that are named below. Integration pools hold no database connection. One writer pool per project applies their outcomes to the project's tables.

---

## Context

The delivery rule is that `publish()` writes the outbox row inside the caller's transaction, the relay ships it, and nothing else calls the engine on the publish path (`AGENTS.md`; design document § 8). The CRM's integration handlers (marketplace, SMS, email) will run in their own pools on their own machines (§ 12). Under that rule, each of those machines holds a connection and a write credential to the CRM's database, and draws on its pooler budget, only to announce what a third party answered.

Engine SDK v1.33.1, read from the vendored source (`node_modules/.pnpm/@hatchet-dev+typescript-sdk@1.33.1*/node_modules/@hatchet-dev/typescript-sdk/`):

1. **Push has no dedupe key.** A push carries `key`, `payload`, `eventTimestamp`, `additionalMetadata`, `priority` and `scope` (`protoc/events/events.d.ts:52-67`; `clients/event/event-client.js:45-96`). It retries inside the client before it throws (`:57`, `:88`; `util/retrier.js:18-19`).
2. **Runs have a creation key.** A workflow may declare `idempotency: { expression, strategy }`, a CEL key the engine checks when it creates a run (`v1/task.d.ts:60-95`, `v1/declaration.d.ts:155-159`, sent at `v1/client/worker/workflow-proto.js:271-281`). No test has proven that the pinned engine (v0.107.0) honours it, and proto3 drops an unknown field silently.
3. **A handler can reach push.** Every task context holds the worker's own client, `ctx.v1` (`v1/client/worker/context.d.ts:86-91`, set at `context.js:108`), and its `events` getter returns the push client (`v1/client/client.js:296-301`).
4. **A child task reads its parent's stored output.** A task names `parents` (`v1/task.d.ts:243-247`; `workflow-proto.js:245`), each task has its own `retries` (`task.d.ts:178-183`; `workflow-proto.js:249`), and the child reads the parent's output from its dispatched payload with `ctx.parentOutput` (`context.js:104-105`, `:176-189`). Kyu's `subscribe()` registers one task today (`packages/sdk/src/consume/subscribe.ts:127`).
5. **A durable body re-runs from the top.** Only `sleepFor`, `waitFor` and `now()` replay (`packages/sdk/src/consume/durable.ts:188-191`).

Envelope ids are clock uuid v7 (`packages/schemas/src/uuidv7.ts:27-37`). `afterMessage` matches only a higher id (`packages/sdk/src/consume/waitMatch.ts:63`). A tenant pause holds messages only in the outbox ([`20260924-tenant-pause-holds-messages-in-the-outbox.md`](20260924-tenant-pause-holds-messages-in-the-outbox.md)).

---

## Options considered

**A. Keep outbox-only, with every pool on a full connection.** Every third-party machine can write every CRM table and draws on the pooler budget. It does not close the dead-worker hole in decision 4 either.

**B. One writer pool, and integration pools on an outbox-only connection.** It keeps one publish path, so pause, cancel, `publishAt` and the § 8.5 queries cover every message, and `kyu_processed` drops redelivered inputs with no engine feature. It still puts a database credential and pooler connections on every third-party machine. No test has proven that `publish()` and `onceById()` work through a transaction-mode pooler. It closes the dead-worker hole no better than C, and under 3(b) it would still stop a redelivered command that arrives after the first run committed, where C does not. The CTO accepts that cost to keep database credentials off third-party machines, and rejects B, including as a fallback.

**C. Handler emit (chosen).** No database credential reaches a third-party machine. Among worker pools, only the writer pool and the flows pool keep database connections. `publish()` stays the one path from request-time code, and `ctx.emit()` is a second, narrower path reachable only from inside a `subscribe()` handler.

**Derived ids.** A retried `emit` would reuse its id, so the writer pool's key would drop the duplicate. Rejected: the envelope id must be uuid v7 (`packages/schemas/src/envelope.ts:19`), and its embedded time orders `afterMessage` (`waitMatch.ts:63`) and bounds run lookups (`runOutcomes.ts:233`). A derived id carries neither.

---

## Decision

1. **A second, sanctioned publish path.** `ctx.emit(definition, data)` exists only on a `subscribe()` handler's context. It does not exist on `createKyu`, `createPublisher`, an API request, or a durable handler (whose body re-runs on replay; the flows pool uses `publish()`). It pushes through the worker's own client (`ctx.v1`) with the payload, metadata and scope the relay sends. The emitted envelope keeps the input's `tenantId` and `correlationId`, and its `causationId` is the input's id.
2. **Weaker guarantees, named.** Durability comes from the run: an emit that still fails after the client's retries fails the task, the task retries under its `retries`, and a task that runs out of retries is a failed run (alerted, replayable). The `emit` task sets `retries` above 0; the SDK sets no default itself (`packages/sdk/src/consume/taskOptions.ts:176`) and the engine's own default is 0 (`v1/task.d.ts:181`). An emitted message has no outbox row, so:
   - A tenant pause does not hold it. A paused tenant's integration outcomes still reach the writer pool.
   - It cannot carry `publishAt`. A delayed follow-on is the flows pool's job.
   - No outbox cancel stops it before it ships.
   - The § 8.5 queries and the outbox-lag alert never see it. Its only record is the engine's event and run history, and an operator looks for a lost outcome in the failed runs of the integration subscription.
3. **Duplicate runs are stopped at run creation, if the engine does it.** Every subscription an integration pool or the writer pool serves declares `idempotency: { strategy: 'ttl', expression: 'input.id', ttlMs: 86_400_000 }` (`ttlMs`, `v1/task.d.ts:78`). Its TTL is at least 24 hours. The relay retries a failed push for ever (§ 8.3), including a short bulk-push answer that re-pushes the whole group (`packages/sdk/src/relay/relay.ts:86-89`). A re-push after an engine outage longer than the TTL can still start a second run; that residue is the 3(b) exposure. `status` is not used: it forgets the key once the first run ends, and a redelivery can come later. This rests on fact 2, so the SDK follow-up's first task is a probe against the local engine. The probe pushes the same event twice with the key set and expects one run. A control workflow without the key must run twice. A late duplicate and a mixed bulk push must also start no second run, and the push answers must stay complete. A failing `emit` retries without rerunning `call`. A failed run with the key set can still be replayed from the dashboard.
   If the probe fails, these steps follow in order:
   - **(a) Upgrade the pinned engine.** The local stack and the Fly config move together, following `docs/operations/kyu-engine-on-fly.md` § Upgrade. The SDK does not say which engine version the key needs: its only engine-version gates cover slot config and durable eviction (`v1/client/worker/engine-version.js:6-9`). The candidate is the newest 0.107.x, then the first release the probe passes on. The probe is re-run on the new pin.
   - **(b) Adopt this decision without the key, if no available release passes.** A relay redelivery can then start a duplicate run. That happens after a crash between the push and the mark, when another relay reclaims a stale claim (§ 8.3), or when a short bulk-push answer re-pushes a group the engine partly accepted. Option B would drop a redelivery that arrives after the first run committed (`kyu_processed`); C without the key does not. The exposure is stated plainly: an integration command delivered twice calls its provider twice, unless that provider accepts an idempotency key. So each integration passes the input envelope id as the provider's idempotency key wherever the provider offers one, and records in its handler when the provider offers none. The writer pool's outcomes stay idempotent on content (decision 5).
4. **Two tasks for an integration handler.** Task `call` calls the third party, passing the input envelope id as the provider's idempotency key where the provider accepts one, and returns an ids-only result. Task `emit` has `call` as its parent, reads `ctx.parentOutput(call)` and emits. A retry of `emit` does not rerun `call` (fact 4; the probe checks it too). One hole remains, and every option shares it: a worker that dies after the provider accepted the call but before `call` completes gets `call` retried, and the call repeats. Only a provider-side idempotency key closes it. Where a provider has none, the handler says so.
5. **Fresh ids, harmless duplicates.** `emit` mints a fresh uuid v7 every time; ids are never derived. A retry of `emit` whose earlier push landed sends a second outcome with a new id, and nothing stops it on the way. It is made harmless by content:
   - The writer pool's writes are upserts keyed on the business entity. An outcome carries the result (a status, the provider's id), never a delta.
   - A wait for an outcome matches on `causationId` equal to the command's envelope id, never on the entity id alone. A duplicate then only re-satisfies a wait that has already been released.
   - The duplicate has a later id, so it passes `afterMessage` and wakes a wake-check-park loop once more. That loop re-reads its own data and parks again (`durable.ts:210-213`).
6. **Payload rule unchanged.** An outcome, and `call`'s stored output, carry ids and small discriminators only (§ 7.4).
7. **Pool layout.** The API, the relay, the writer pool and the flows pool hold database connections. Integration pools hold none. An integration machine holds three credentials and nothing else: the engine worker token, its provider's credentials, and a CRM API token that can only read (decision 8). The writer pool is one pool per project. It consumes integration outcomes with a concurrency key on the entity id (`maxRuns: 1`) and writes by upsert, so it is idempotent on content.
8. **Personal data is read at send time from the CRM API.** An integration handler that needs personal data (a phone number, an email address, an email body) reads it in task `call`, just before the provider call. It reads from the CRM's own API with a short-lived service token that can only read, keyed by the ids in the envelope (the business tenant id and the message or contact id). The command never carries that content, so the payload rule (§ 7.4) has no exception here. What was read stays in the handler's memory: it never goes into `call`'s output, an emitted message, a handler log or a thrown error's message, because the engine stores all four (`worker-internal.js:332`, `:365-368`; `context.js:318-341`). When the read says the message was cancelled or the contact opted out, the handler sends nothing. There are three reasons:
   - No personal data reaches the bus: not the engine's run history, not RabbitMQ, not the engine database.
   - The read happens at send time, so a cancellation or opt-out made after the command was queued is honoured.
   - The credential is narrower than a database connection, and it can be rotated.
   The costs: one API read per send; the CRM API must expose an internal read endpoint with service authentication; and a CRM API outage pauses sends until the engine's retries succeed. A read that is still failing when its retries run out leaves a failed run, which is replayable.

---

## Consequences

**Positive**

- Machines that talk to third parties hold no database credential and cannot write CRM tables. Each holds exactly the engine token, its provider's credentials and a CRM API token that can only read.
- No personal data enters the engine's run history, RabbitMQ or the engine database. A cancellation or opt-out made after queueing is honoured, because the content is read at send time.
- The pooler budget is drawn only by the API, the relay, the writer pool and the flows pool. Adding an integration machine adds no connection.
- An outcome reaches the writer pool without waiting for a relay tick.

**Negative**

- Two publish paths with different guarantees. Pause, `publishAt`, outbox cancel and the § 8.5 queries cover only `publish()`. Accepting this amends the delivery rule in `AGENTS.md:87` and `AGENTS.md:88`: idempotent on the envelope id no longer holds for emitted duplicates, which are idempotent on content instead.
- Duplicate safety rests on content: upserts in the writer pool and `causationId` matches in waits. Review enforces these, not the SDK.
- Duplicate-run protection depends on an engine feature that is not yet proven (decision 3). Without it, a redelivered command repeats a provider call wherever the provider has no idempotency key.
- `subscribe()` gains a two-task shape, and `runOutcomes`, which assumes one task per subscription (`packages/sdk/src/consume/runOutcomes.ts:241-243`), must change with it.
- An integration machine's worker token can push any event in the bus tenant and read its run history (ids only). A leaked token can forge outcomes.
- Every send costs one CRM API read. The CRM API must expose an internal read endpoint with service authentication, and issue and rotate the tokens that can only read. A CRM API outage pauses sends until the engine's retries succeed, and past the last retry a send becomes a failed run.

---

## Do not

- Emit from an API request, `createKyu`, `createPublisher` or a durable handler, or push from handler code other than through `ctx.emit`.
- Ship the emit before the probe has run. If the probe fails, ship it only after decision 3(a) has been tried.
- Derive an envelope id.
- Write a writer-pool effect that is not idempotent on content (an increment, or an append with no key).
- Match a wait for an outcome on the entity id alone.
- Put a provider's response body on the bus.
- Carry personal data in a command, or return it from `call`, emit it, log it or put it in a thrown error's message. Read it from the CRM API at send time.

---

## Reopen when

- The engine adds a dedupe key to push, which would let a retried `emit` be dropped by id.
- Integration outcomes must be held by a tenant pause.
