# The outbox is not the audit log

**Status:** accepted on 2026-10-02 (CTO, issue #30)
**Date:** 2026-10-02
**Parent:** none — raised as design open question 3 and answered while a consumer sized its own audit trail against the bus.
**This is not** a decision about engine run-history retention (N6, open question 5), nor about what a consumer's audit trail contains or how it captures it. That is the consumer's design.

`kyu_outbox` is a delivery buffer. A producer prunes published rows on a schedule, keeps no row for the record, and holds its durable record of what happened in its own tables.

---

## Context

Open question 3 asked whether the outbox is also the producer's durable event log, or whether the engine's history is enough. Section 8.5 left the producer "keeping every row while open question 3 is unanswered", and the README says cancelled rows are kept because nothing prunes them yet. Without an answer every producer's outbox grows without bound.

The forces:

- **Payloads are ids only** (section 7.4). An envelope says that `shop.order.placed` happened to order 42, by which actor, in which tenant, caused by which message. It never says what the order looked like before or after, because the design keeps personal data and state snapshots out of the engine's history. An audit trail is defined by exactly that before/after content.
- **The engine's history is observability** (non-goals, N6). Runs are dropped by whole days after the retention period, thirty days in production. A compliance record needs years and immutability.
- **Domain ledgers are a stated non-goal to replace** (non-goals). An integration ops ledger and a wire log stay the domain-level record and link to bus runs. An audit trail is the same kind of record.
- **The outbox is on the producer's hot write path** (section 8.2). Every `publish()` inserts into it inside the caller's transaction, and the relay's claim query scans the pending set (section 8.5, and the paused-tenant ADR notes the scan cost at tens of thousands of rows). A table that is also a permanent log competes with its own delivery job.
- **Replay of a durable handler may read the outbox.** The README's `onceById` guidance lets a handler recover the ids it already published with `SELECT id FROM kyu_outbox WHERE envelope->>'causationId' = $1` "while the rows are still unpruned", and recommends writing those ids into the handler's own ledger row in the same transaction instead. A prune policy has to respect the first path or retire it.
- **The envelope already carries the join keys an audit trail needs**: `id`, `actorUserId`, `tenantId`, `orgUnitId`, `correlationId`, `causationId`, `source`, `occurredAt` (section 7.1). A consumer that stamps its own audit rows with the envelope id and correlation id can join its record to the bus run without the bus storing anything extra.

---

## Options considered

**A. Keep every outbox row for ever; the outbox is the event log.** Free to build, and `SELECT … FROM kyu_outbox` answers "what was published". But the rows hold ids, not state, so they cannot answer any audit question on their own; the table grows on the hot write path; the relay's pending-set scan degrades; and the SDK's immutable-migration rule means the table's shape cannot later be tuned for archival reads without a new table anyway. Lost.

**B. Lean on the engine's run history as the record.** Nothing to build. But retention is thirty days by design, the data is ids only, and the engine is a shared company system, so a consumer's compliance obligation would rest on another system's retention setting. Lost.

**C. Add a Kyu-owned archive table or a log sink to the SDK.** Keeps the bus self-contained. But it would be an ids-only log of what was announced, which is still not an audit trail, and it would put the bus in the business of long-term storage for every consumer, with every consumer's retention and privacy rules. The design already says the bus is not a replayable log. Lost.

**D. The outbox is a delivery buffer, pruned on a schedule; the consumer's own tables are the durable record.** The outbox does one job. A consumer that needs an audit trail captures state changes in its own database under its own tenant scope, stamps those rows with the envelope and correlation ids, and joins to the bus for the delivery story. Won, because it follows from three rules the design already has: ids-only payloads, run history as observability, and domain ledgers staying in the domain.

---

## Decision

1. **The outbox is a delivery buffer.** `kyu_outbox` holds a row from `publish()` until the relay has shipped it, retired it, or a cancel has stopped it. It is not the producer's event log and never the audit trail.
2. **Producers prune on a schedule.** A producer runs `prunePublished({ publishedBefore })` and `pruneRetired({ retiredBefore })` from its own scheduler. Cancelled rows join the pruned set with `pruneCancelled({ cancelledBefore })`, added to the SDK by this decision. The SDK never deletes a row on its own.
3. **The prune floor is the longest durable wait plus one engine retention period.** A producer prunes nothing younger than that: a parked run or a dashboard replay may still read a row by its envelope id, and the engine's history for that run is still there to compare against. The recommended default is published rows after 45 days, retired and cancelled rows after 45 days from when they were retired or cancelled.
4. **A handler's durable record is its own ledger row, not the outbox.** The README's "read back from `kyu_outbox` by `causationId`" path stays as a convenience for a run younger than the prune floor; the recommended path is the ledger write in the same transaction as the publish, as the shop example does.
5. **A consumer's audit trail lives in the consumer.** A consumer that must answer "who changed what, from and to, and why" captures state changes in its own database under its own tenant scope, stores before and after values there, and stamps each row with the envelope `id` and `correlationId` of the message that announced the change. The bus carries the ids; the consumer carries the record.
6. **The retention period of the engine is unchanged.** N6 and open question 5 stand on their own.

---

## Consequences

**Positive**

- Every producer's outbox has a bounded size, and the relay's pending-set scan stays small.
- Audit, privacy and retention obligations stay with the system that owns the data and the tenant relationship, which is the only system that can meet them.
- The join from a consumer's audit row to a bus run is one id already in every envelope, so nothing is added to the SDK for it.
- Open question 3 and the "keep every row" caveat in section 8.5 close.

**Negative**

- One more SDK helper, `pruneCancelled`, and a README change to say cancelled rows are now prunable.
- A producer that forgets to schedule the prunes gets an unbounded outbox, as today. The section 8.5 operations list gains an "oldest published row" check so the gap is visible.
- A durable run parked longer than the prune floor that relies on the outbox read-back path, rather than its own ledger, cannot recover its published ids. The ledger path is the documented one; this makes it the only safe one past the floor.

---

## Do not

- Add an archive, snapshot or history table to the SDK's migrations.
- Widen the envelope or the outbox row to carry before/after state so that the outbox can serve as an audit record.
- Point a consumer's compliance or audit feature at `kyu_outbox` or at the engine's run history as its source of truth.
- Raise the engine's retention period to stand in for a consumer's audit retention.

---

## Reopen when

- A consumer that cannot keep its own tables (no database of its own) joins the bus and needs a record of what it published.
