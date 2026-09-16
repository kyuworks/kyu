# Code Review Checklist

Use this checklist on fresh reviews of code changes, diffs, and implementation follow-ups.

## Coverage Areas

### Behavior and Regression Risk

- Does the change preserve intended behavior on existing paths?
- Are new conditions, defaults, or fallback branches safe?
- Could a fix for one caller break another caller that shares the same symbol or data contract?

### Contracts and Compatibility

- Are request, response, prop, type, and schema changes compatible with live callers?
- If rollout is transitional, does the code support both old and new paths where the design says it should?
- Are comments, docs, and tests consistent with the real contract?

### Data Invariants

- Are linked entities validated together when needed?
- Are uniqueness, dedupe, archival, and null semantics preserved?
- Could unresolved or optional values match more broadly than intended?

### Validation and Error Handling

- Does the code reject invalid input at the right boundary?
- Are error messages and fallback behavior aligned with the product rule?
- Does the code silently accept states the design says should be blocked?

### Boundaries and Architecture

- Does the change respect package boundaries (`packages/schemas` owns message shapes, `packages/sdk` owns the outbox, relay, and Hatchet wrapper)?
- Did the diff weaken policies, linting, typing, or gate enforcement?
- Did convenience casts, suppressions, or shortcuts sneak in?

### Bus Contract

- Is the envelope validated at publish and again at consume, against the schema in `packages/schemas/src`?
- Is every handler idempotent on the envelope id (a redelivery of the same id has no second effect)?
- Is the outbox row written inside the caller's transaction, so a rollback removes it and a commit makes it durable?
- Do Hatchet payloads carry ids and small discriminators only, with no secrets and no personal data?
- Where the design needs per-key ordering, does the subscription declare the concurrency key?

### Operational Paths

- If the code claims a repair or replay path exists (a failed run in the Hatchet dashboard, an outbox row with `last_error`), is it actually reachable?
- Could a manual-only path be mistaken for supported behavior?

### Tests and Confidence

- Are the highest-risk paths covered?
- Are regression tests added where behavior changed?
- If tests are missing, is that a material confidence gap or acceptable follow-up?

## Finding Prompts

For each issue you raise, answer:

- What breaks, regresses, or remains ambiguous?
- What concrete fix would you recommend?
- What nearby files, callers, or flows should be checked as side effects?
- What proof would let a later delta review close the finding decisively?

## Good Closure Proofs

- A code change that updates all d=1 callers
- A test covering the changed behavior or regression path
- Removal of an invalid fallback or wildcard match
- A boundary-safe implementation that keeps policy and gate wiring intact
