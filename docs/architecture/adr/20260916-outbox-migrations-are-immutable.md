# Outbox migrations shipped to consumers are immutable

**Status:** accepted
**Date:** 2026-09-16
**Parent:** [design document](../../design/qtaxis-requirements-and-design.md) § 8
**This is not** a decision about how a consumer runs migrations; that is the consumer's own runner.

Every file under `packages/sdk/migrations/` is applied by consumers to databases the bus does not control. Once a file is on `main` it is never edited, renamed or deleted.

---

## Context

The SDK's outbox and processed-id tables live in each producer's and consumer's own database. The SDK ships the SQL; the consumer's migration runner applies it and records the file name. A changed file would leave two databases that both believe they applied "the same" migration with different results, and a renamed file would make a runner apply it twice.

---

## Options considered

**A. Ship a schema and let each consumer write its own migration.** Drift between consumers within a month. Lost.

**B. Ship migrations and allow edits until a release tag.** Requires every consumer to know which tag they applied. Lost.

**C. Ship migrations as immutable files from the moment they land on `main`.** Fix forward with a new file. Won.

---

## Decision

1. **New files only.** `packages/sdk/migrations/<YYYYMMDDHHMMSS>_<slug>.sql`, timestamp greater than the latest file.
2. **A mistake is corrected by another migration**, never by editing the first.
3. **`scripts/gates/check-migration-immutability.sh` is armed** and fails any PR that changes, renames or deletes a file already on `main`.

---

## Consequences

**Positive**

- Every consumer can trust that a file name means one exact set of statements.

**Negative**

- Mistakes leave a visible trail of corrective files. That trail is the point.

---

## Do not

- Edit, rename or delete a file under `packages/sdk/migrations/` that exists on `main`.
- Disarm the gate to land a change.
