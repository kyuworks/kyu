# The engine's internal queue runs on RabbitMQ in every deployed environment

**Status:** accepted on 2026-09-25
**Date:** 2026-09-25
**Parent:** archived issue 202
**This is not** a decision about the engine's database plan, Hatchet's separate-image production topology, or the engine itself: [`20260916-hatchet-is-the-engine.md`](20260916-hatchet-is-the-engine.md) stands (hatchet-lite, a dedicated Postgres cluster per environment).

Every deployed Kyu engine keeps Hatchet's internal message queue on a RabbitMQ broker of its own, not in its Postgres database. This amends requirement N1 ("no new datastore family") for the engine's queue only.

---

## Context

Hatchet keeps its internal message queue either in the engine's Postgres database or in RabbitMQ. hatchet-lite uses Postgres unless one of four queue variables is set (`docs/operations/kyu-engine-on-fly.md`, "Queue on RabbitMQ"). Requirement N1 (`docs/design/kyu-requirements-and-design.md` § 4.2) asks for no new datastore family, so the first deploy (issue #162) used the Postgres queue.

The shop's failure harness ran at report size in `syd`, beside the dev engine `<engine-app>`, on several topologies (`docs/proofs/2026-09-23-shop-failure-harness-fly-dev.md`, comparison table). `outbox-backlog` must drain 50,000 outbox rows within 5 minutes, about 167 rows a second.

- **Postgres queue** (issues #166 on Basic, #173 on Starter, #175 on Launch): `outbox-backlog` failed every time. On Launch it drained about 162 rows a second and left 600 of 50,000 rows. `tenant-load` passed only on Launch.
- **RabbitMQ, both clusters on Launch** (issue #176): both scenarios passed. `outbox-backlog` drained about 976 rows a second and finished in 47 of 300 seconds. No error line in the engine or RabbitMQ log.
- **RabbitMQ, engine cluster on Basic** (issue #198): passed at smoke size, failed both scenarios at report size. The engine lost its connections to its own database. One run; this fits the limit moving from the queue to the engine's own state writes, and the database's recovery and read-only lines were not checked.

The evidence has limits (proof page, #176 "What this run does not prove"): one run per topology; hatchet-lite in RabbitMQ mode, not Hatchet's separate-image production shape; one engine machine and one single-node broker; the queue switch and an engine restart happened together; no metrics were read; the broker going away was never tested.

Dev has run the broker since 2026-09-23: app `<rabbitmq-app>`, `rabbitmq:3.13.7`, one `performance-1x` machine, a 3 GB volume (runbook, `-s 3`), no public address. Hatchet documents RabbitMQ as its default production queue (runbook, "Queue on RabbitMQ").

---

## Options considered

**A. Postgres queue on a larger database plan.** Meets N1 as written. It never met `outbox-backlog`'s window on Basic, Starter or Launch, and no plan above Launch was tried. Lost.

**B. Postgres queue with a wider window or a smaller load.** Changes the test to fit the result; the window comes from the design, not from the engine. Lost.

**C. Hatchet's full production topology now.** Separate engine images with RabbitMQ, the scaling path in design document § 12. More machines to run for a load that one hatchet-lite machine on RabbitMQ already met. Deferred until N4 is exceeded, not rejected.

**D. hatchet-lite with its queue on RabbitMQ.** One extra small machine per environment. It met every window it was measured against on Launch, and it is the queue option C would use as well. Won.

---

## Decision

1. **Every deployed environment runs the engine's internal queue on RabbitMQ.** The engine's Fly config sets `SERVER_MSGQUEUE_KIND = 'rabbitmq'` (`infra/hatchet/fly/fly.toml`).
2. **One broker per environment.** Each environment has its own RabbitMQ app beside its engine (dev: `<rabbitmq-app>`), on the private network only, with its own data volume. A production deployment carries its own broker too.
3. **The CTO sets the broker's secrets through the placeholder scripts.** `infra/hatchet/fly/rabbitmq/secrets.sh` prints the commands for the broker's user and password; `infra/hatchet/fly/secrets.sh` prints the engine's `SERVER_MSGQUEUE_RABBITMQ_URL`. The values come from 1Password (N7). No file holds them and no agent reads them back.
4. **N1 is amended, not met.** RabbitMQ is the one datastore family added beside Postgres, for the engine's queue only. Nothing else in Kyu uses it.
5. **The local Docker stack keeps the Postgres queue.** `infra/hatchet/compose.yaml` serves development and tests, where the load is small.
6. **A switch back to the Postgres queue is an emergency step only.** The runbook keeps the steps. Staying on the Postgres queue in a deployed environment needs a new ADR that supersedes this one.

---

## Consequences

**Positive**

- On the same engine machine and database plan, the measured backlog drain went from about 162 to about 976 rows a second (#175 to #176). The queue switch and an engine restart happened together, so the run does not separate the two.
- The queue no longer shares the engine's database. In one run on Basic (#198), the limit fits the engine's own state writes rather than the queue.
- Hatchet's full production topology, when it is needed, uses the same kind of broker.

**Negative**

- A second datastore family to operate in every environment: a machine, a volume, credentials, image upgrades (`rabbitmq:3.13.7` is pinned), and a log to watch for `alarm` lines.
- The engine exits at boot when the broker is down (runbook, "Switching the engine to RabbitMQ"), so the broker is on the engine's start path.
- The decision rests on dev evidence with the limits listed in Context. A single-node broker has no failover, and nothing has tested the broker going away.
- The local stack and the deployed environments run different queues, so a queue-specific fault can pass locally and appear only on Fly.

---

## Do not

- Point two environments, or two engines, at one broker.
- Give the broker a public IP address or expose a management UI outside the private network.
- Connect a consumer, the relay or the SDK to RabbitMQ. They talk to the engine only.
- Put a broker credential in a file, a commit, an issue or a chat message.

---

## Reopen when

- A deployed engine on RabbitMQ misses a harness window that the same topology met before, and the broker is the cause.
- Hatchet deprecates the RabbitMQ queue, or recommends the Postgres queue for production.
- A report-size run on the Postgres queue meets every window on a database plan the company will pay for.
