# Plan Review Checklist

Use this checklist on fresh reviews of specs, plans, migrations, rollout docs, and implementation proposals.

## Coverage Areas

### Product Contract

- Are the supported states explicit?
- Are temporary rollout states distinguished from final-state rules?
- Do "must" statements agree with examples, migration behavior, and admin repair paths?

### Sequencing and Merge Safety

- Can each PR or work unit merge without breaking existing callers?
- Are shared types and contracts introduced before code that depends on them?
- Does the plan clearly separate read-path migration from write-path migration if needed?

### Caller and Surface Coverage

- Does the plan cover all known read paths?
- Does it cover all known write paths, handlers, relay loops, cron handlers, and bulk operations?
- If the plan says an existing SDK helper or Hatchet feature supports something, is there a real file or documentation page backing that claim?

### Migration and Backfill

- Is the source of truth clear before, during, and after the migration?
- Are null, unresolved, archived, and fallback states explicitly defined?
- Is rerun behavior idempotent?
- If one row expands into many, are dependent records remapped or intentionally left for repair?

### Invariants and Constraints

- Are key relationships validated, not just referenced independently?
- Is dedupe enforced at the right layer?
- Could `null` accidentally behave like a wildcard?
- Could cached text fields drift from FK-backed truth?

### Bus Contract

- Is the envelope validated at publish and at consume, with one schema owning the shape?
- Is idempotency on the envelope id stated for every new handler?
- Is the transaction boundary of the outbox write named: the caller's transaction, not a separate one?
- Do payloads stay ids-only, with no secrets or personal data entering Hatchet?
- Where ordering matters, is the per-key ordering declared as a concurrency key on the subscription?

### Repair and Operations

- If the plan relies on manual repair, is the repair path actually available?
- Is the responsible UI, API, or operational process named accurately?
- If the path is manual-only, does the wording say that plainly?

### Drift and Appendices

- Do audit trails, breaking-change notes, examples, and appendices still match the current design?
- If not, is the mismatch blocking or cleanup only?

## Finding Prompts

For each issue you raise, answer:

- What exact statement or dependency conflicts?
- What change would resolve it?
- What adjacent section is most likely to fall out of sync when this is fixed?
- What proof would let a later delta review close this cleanly?

## Good Closure Proofs

- Updated plan text that removes the contradiction
- A code reference proving the claimed existing behavior exists
- A revised rollout rule showing before, during, and after states
- A migration rule that is idempotent and explicit about dependent data
