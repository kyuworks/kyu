# Architecture Proof Matrix

Complete this before drafting or superseding an ADR. Keep the filled copy in
the parent issue, PR, or its existing planning directory. The ADR records the
decision; this matrix records the changeable evidence that supports it.

## Scope

- Decision:
- Parent issue:
- Proposed ADR:
- Evidence revision (commit SHA):

## Acceptance criteria

| Issue acceptance criterion | Existing evidence or required decision | Affected artifacts | Disposition |
| --- | --- | --- | --- |
| AC-1 | `path:line`, issue link, or explicit unknown | Code, test, document, or ADR | covered / gap / out of scope |

## Runtime consumers and call stacks

Use one row per publish call, handler, relay loop, cron handler, webhook, or
other consumer. For a changed message path, show every layer. Validate the
envelope once at the trust edge (publish and consume); interior layers receive
the typed envelope.

| Consumer or entry point | Call stack and owners | Input → output | Errors | Side effects and transaction boundary | Evidence |
| --- | --- | --- | --- | --- | --- |
| Example | caller → `kyu.publish` → outbox row → relay → Hatchet → handler | typed payload → envelope → handler effect | schema invalid, non-retryable | outbox row in the caller's transaction; no network call in that transaction; handler idempotent on envelope id | `path:line` |

## Existing decisions and live documentation

Search ADRs, architecture documentation, plans, schemas, and owning code. Do
not create a second owner for a rule that already has one.

| Existing source | Status and claimed ownership | Agreement or conflict | Disposition |
| --- | --- | --- | --- |
| `path:line` | accepted / proposed / mutable | agrees / overlaps / conflicts | reuse / supersede / update in this change |

## Rollout and compatibility

| Phase | Reads | Writes | Existing callers or data | Failure and rollback behaviour | Evidence |
| --- | --- | --- | --- | --- | --- |
| Current | | | | | |
| Transition | | | | | |
| Final | | | | | |

## Explicit non-decisions

| This change does not decide | Why it is outside this decision | Owner or reopen trigger |
| --- | --- | --- |
| | | |

## Reconciliation

- Blocking unknowns:
- Sources that must change with the ADR:
- Scoped checks or tests that will prove the implementation:
