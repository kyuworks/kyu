# Each producer application runs its own engine

**Status:** accepted on 2026-10-06 (CTO, issue #67)
**Date:** 2026-10-06
**Parent:** [#67](https://github.com/kyuworks/kyu/issues/67)
**This is not** a decision about the engine or its topology ([`20260916-hatchet-is-the-engine.md`](20260916-hatchet-is-the-engine.md) and [`20260925-engine-queue-runs-on-rabbitmq.md`](20260925-engine-queue-runs-on-rabbitmq.md) stand), about one bus tenant per project per environment (design § 6.2), or about how messages cross from one project to another (design § 6.2: an explicit relay, never a shared tenant).

Kyu runs no deployed engine of its own. Each producer application that uses the bus runs its own Hatchet engine, per environment, from the template in `infra/hatchet/fly/`, and owns its database, bus tenants, tokens, alerts and upgrades.

---

## Context

Kyu is a library plus deployment config (`AGENTS.md`). [`20260915-kyu-is-a-standalone-system.md`](20260915-kyu-is-a-standalone-system.md) counts "a new deployable to run, secure, back up and upgrade" as its cost, and does not say who runs it.

Until 2026-10-06 one engine ran on Fly for the Kyu side: a `hatchet-lite` app, a RabbitMQ app and a managed Postgres cluster, all built from `infra/hatchet/fly/`. Its users were the shop example's failure harness and Kyu's own lanes. No consuming project had a bus tenant on it.

Running an engine is operator work for whoever holds the Fly organisation and the password manager: eight secrets (`infra/hatchet/fly/secrets.sh`), the admin account and the signup rules, one bus tenant and one 90-day worker token per project, backups and a restore rehearsal, failure alerts (issue #3 needed a Slack app and two more secrets), and an upgrade each time the pinned tag moves.

The data the engine holds belongs to the producer. The outbox is in the producer's database, and a consumer's audit trail is in the consumer's ([`20261002-the-outbox-is-not-the-audit-log.md`](20261002-the-outbox-is-not-the-audit-log.md)). The engine's run history is that producer's messages, so its retention, who may sign in and replay, and where its alerts go are that producer's choices. On one engine, one project's load slows every tenant.

Kyu tests the SDK without a deployed engine: the local stack (`infra/hatchet/compose.yaml`), a `hatchet-lite` service in CI (`.github/workflows/ci.yml`), and the weekly run against the newest release (`.github/workflows/newest-engine.yml`). The shop example's CI runs its own `hatchet-lite` service.

---

## Options considered

**A. Kyu runs one shared engine per environment for every project.** One upgrade and one place to issue bus tenants. The Kyu side becomes an operations team for an engine whose load and data come from other projects, and it holds tenant creation and token issue for all of them. Lost.

**B. Kyu runs a dev engine; producers run their own production engines.** Keeps a place to try the template on Fly. Its only users were the harness and Kyu's lanes, it costs money and operator time every month, and every page then has to say which kind of engine it means. The local stack and CI already cover Kyu's tests. Lost.

**C. Each producer application runs its own engine from a Kyu template.** Kyu ships the template, its config tests and a guide; the producer's operator runs every step. Won, because the application that owns the data and the tenant relationship also owns the engine, and Kyu's tests need no deployed engine.

---

## Decision

1. **Kyu runs no deployed engine.** No Fly app, database cluster, broker, bus tenant or token belongs to the Kyu side in any environment. The engine Kyu ran on Fly is decommissioned.
2. **The producer application runs its own.** Its operator creates the engine for each environment, stages its secrets, creates bus tenants, mints tokens, takes backups, turns on alerts if it wants them, and upgrades it, following `docs/operations/kyu-engine-on-fly.md`.
3. **`infra/hatchet/fly/` is a template.** A producer copies it from the Kyu release tag that matches its SDK version. Kyu keeps it and its config tests green, and moves its engine tag together with the test infrastructure (`scripts/gates/check-engine-image-tag.sh`).
4. **Test infrastructure stays.** The local stack and the CI engine are how Kyu tests the SDK. The shop example tests against its own CI engine and the local stack.
5. **Agents never touch secrets.** On any engine, an agent never stages or reads a secret, signs in to Fly or a dashboard, or mints, reads or prints a token.

---

## Consequences

**Positive**

- Nothing runs on the Kyu side and nobody is on call for it. Kyu's work is the SDK, the template and the guide.
- Each producer chooses its own database plan, retention, alert routing and upgrade timing, and no other project's load reaches its engine.
- A tenant on a producer's engine is for its own application. Another project that must receive its messages gets its own tenant, and that token goes to that project's operator through that project's secret store, never through the producer's.

**Negative**

- Every producer pays for and runs three Fly resources per environment, and repeats the first deploy.
- Upgrades happen per producer. Kyu's CI proves a new tag, but each copy of the template moves on its producer's schedule, so engines in the company can run different tags.
- Kyu no longer deploys the template, so a fault that appears only on Fly is first seen in a producer's environment. The config tests check the files, not a live deploy.
- The sizing and restore figures in the guide come from the decommissioned engine, measured in September 2026, and age from here.
- Issue #3 (failure alerts on the Kyu engine) closes as not Kyu's work. Alerts become an optional step for each operator.

---

## Do not

- Add a Kyu-owned Fly app, cluster, broker, bus tenant or token, or a page step in which the Kyu side creates one for a project.
- Add alerting, dashboards or on-call that the Kyu side runs for any engine.
- Delete `infra/hatchet/fly/` or its config tests while producers copy it.
- Point Kyu's CI or the shop example at a deployed engine.

---

## Reopen when

- Producers need each other's messages often enough that an explicit relay per pair costs more than one shared engine run by a team that owns it.
