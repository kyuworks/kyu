# Kinesin is a standalone system, not a library extracted from Camba

**Status:** accepted
**Date:** 2026-09-15
**Parent:** [design document](../../design/kinesin-requirements-and-design.md)
**This is not** a decision about which engine runs it (see [20260916-hatchet-is-the-engine](20260916-hatchet-is-the-engine.md)).

The company message bus is its own repository and its own deployable, consumed by Camba and by other company projects through an SDK. It is not an in-house queue lifted into a package.

---

## Context

Camba had a working Postgres job queue with retries, dead-lettering, priority and dedupe, and fifteen job types on it. It had no domain events: every fan-out was hand-wired at a post-commit seam, one dispatcher call after another, and the flows engine worked around the commit race with a five-second delay. Other company projects, some in real estate and finance, needed the same capability and could not depend on Camba.

---

## Options considered

**A. Extract Camba's queue into a library.** Cheapest for Camba. Ties every other project to Camba's dedupe indexes, tenancy assumptions and release cadence. Lost.

**B. Build the bus inside Camba and expose it over HTTP.** Keeps one codebase. Makes Camba a dependency of projects that have nothing to do with it, and puts Camba's deploy on every consumer's critical path. Lost.

**C. A standalone system with its own repository, engine and SDK.** More to run. Every project consumes the same contract; Camba is one consumer among several. Won.

---

## Decision

1. **Kinesin lives in `Camba-nz/kinesin`** and ships `@kinesin/schemas` and `@kinesin/sdk`.
2. **The bus knows no domain.** No lead, listing, org unit or customer concept enters the SDK. Business tenant identity is metadata on the envelope.
3. **Camba migrates onto it consumer-first**, one job type at a time, keeping its own ledgers.

---

## Consequences

**Positive**

- One contract for every project. A consumer can be added without touching a producer.
- Camba's queue can be retired job type by job type.

**Negative**

- A new deployable to run, secure, back up and upgrade.
- Two repositories to keep in step while Camba migrates.

---

## Do not

- Add a Camba, real-estate or finance concept to `packages/schemas` or `packages/sdk`.
- Make Camba's API a dependency of the bus.

---

## Reopen when

- A second consumer never materialises within a year of the first release.
