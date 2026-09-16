# Kinesin is a standalone system, not a library extracted from a product

**Status:** accepted
**Date:** 2026-09-15
**Parent:** [design document](../../design/kinesin-requirements-and-design.md)
**This is not** a decision about which engine runs it (see [20260916-hatchet-is-the-engine](20260916-hatchet-is-the-engine.md)).

The company message bus is its own repository and its own deployable, consumed by every company project through an SDK. It is not one project's private job queue lifted into a package.

---

## Context

One project had a working Postgres job queue with retries, dead-lettering, priority and dedupe, and a dozen or so job types on it. It had no domain events: every fan-out was hand-wired at a post-commit seam, one dispatcher call after another, and its workflow engine worked around the commit race with a fixed delay. Other company projects needed the same capability and could not depend on it.

---

## Options considered

**A. Extract the existing queue into a library.** Cheapest for the project that owns it. Ties every other project to that project's dedupe indexes, tenancy assumptions and release cadence. Lost.

**B. Build the bus inside one project and expose it over HTTP.** Keeps one codebase. Makes that project a dependency of projects that have nothing to do with it, and puts its deploy on every consumer's critical path. Lost.

**C. A standalone system with its own repository, engine and SDK.** More to run. Every project consumes the same contract; the first consumer is one consumer among several. Won.

---

## Decision

1. **Kinesin lives in `github.com/Camba-nz/kinesin`** and ships `@kinesin/schemas` and `@kinesin/sdk`.
2. **The bus knows no domain.** No product's entities enter the SDK. Business tenant identity is metadata on the envelope.
3. **Consumers migrate onto it one job type at a time**, keeping their own domain ledgers.

---

## Consequences

**Positive**

- One contract for every project. A consumer can be added without touching a producer.
- A consumer's private queue can be retired job type by job type.

**Negative**

- A new deployable to run, secure, back up and upgrade.
- Two repositories to keep in step while each consumer migrates.

---

## Do not

- Add a product-specific concept to `packages/schemas` or `packages/sdk`.
- Make any product's API a dependency of the bus.

---

## Reopen when

- A second consumer never materialises within a year of the first release.
