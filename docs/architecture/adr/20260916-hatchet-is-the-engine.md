# Hatchet, self-hosted, is the engine under Kinesin

**Status:** accepted
**Date:** 2026-09-16
**Parent:** [design document](../../design/kinesin-requirements-and-design.md)
**This is not** a decision about the outbox, which Hatchet does not provide and the SDK owns.

Kinesin's delivery, retries, ordering, rate limits, timers, durable waits and run history come from a self-hosted Hatchet control plane. The SDK wraps it; consumers never call it directly for bus work.

---

## Context

The requirements (design document § 4) need fan-out to many subscribers, single-subscriber commands, retries with backoff, dead-lettering, delayed and cron delivery, per-key ordering, coalescing, durable waits correlated to future events, priority, rate limits, inbound webhooks, and a run history with replay. Camba runs on Fly with Postgres and has no Redis. The company wants to self-host and to avoid per-message fees.

---

## Options considered

**A. BullMQ on Redis.** A mature work queue. No topics, no correlation waits, per-key ordering only in the paid tier. Adds Redis to every consuming project. The bus layer on top would be thick. Lost.

**B. pg-boss on Postgres.** Has publish-to-subscribed-queues, delay, retry, dead-letter and singleton keys. No durable waits, no per-key ordering, no dashboard. Lost.

**C. Restate.** Strong per-key ordering through virtual objects. Fan-out is not first-class. Lost.

**D. Temporal.** The reference for orchestration. No event topics and the heaviest infrastructure of the set. Lost.

**E. Hatchet, self-hosted.** Covers every functional requirement except the transactional outbox. MIT licence, no self-hosting fee. `hatchet-lite` runs on Postgres alone. TypeScript, Python, Go and Ruby SDKs. Won.

---

## Decision

1. **Hatchet Lite on Fly with a dedicated Postgres** per environment is release one. The Compose or Helm topology is the scaling path, with no SDK change.
2. **One Hatchet tenant per company project per environment.** Tokens are per tenant. Cross-project traffic is an explicit relay.
3. **The SDK owns what Hatchet lacks:** the transactional outbox and relay, the envelope, idempotency on envelope id, and the company contract.
4. **Consumers do not call the Hatchet SDK directly for bus work.** A gap in the Kinesin SDK is filled in the Kinesin SDK.

---

## Consequences

**Positive**

- Fan-out, correlation waits, per-key ordering and rate limits are configuration, not code.
- A dashboard with run history and replay exists on day one.

**Negative**

- Hatchet's release cadence is ours to track. Pin the image; upgrade through a runbook.
- Hatchet's data retention caps how far back history goes; long-term records stay in consumers' ledgers.

---

## Do not

- Import `@hatchet-dev/typescript-sdk` in a consumer for bus work.
- Put personal data in a Hatchet payload. Envelopes carry ids.
- Run Hatchet against a transaction-mode connection pooler.

---

## Reopen when

- Hatchet relicenses future releases, or the project stalls for six months.
- Sustained load exceeds the design target and the Compose topology cannot absorb it.
