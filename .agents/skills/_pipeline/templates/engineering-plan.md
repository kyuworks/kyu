# Engineering plan template

Written to `planning-gitignored/plans/{slug}.md`. Pairs with `planning-gitignored/plans/{slug}-testing.md`.

The issue in phase 3 is built from this document minus the execution steps. So write
sections 1–5 as if a stranger will read them, and section 6 as if only the implementer
will.

---

```markdown
# {Feature name}

**Slug:** {slug}
**Branch:** feat/{slug}
**Research:** planning-gitignored/research/{slug}/ | none — direct from prompt
**Testing sub-plan:** planning-gitignored/plans/{slug}-testing.md
**Complexity:** Small | Medium | Large

## 1. Behaviour

What a consumer of the bus can do after this that they cannot do now. Plain language,
no jargon, no file names. Two or three sentences.

## 2. Non-goals

What this deliberately does not do, and why. Include the shortcut a future implementer
would reach for and regret — name it, and say what goes wrong if they take it.

## 3. Files and contracts

| File | Change | Why |
|---|---|---|
| `packages/sdk/src/real-file.ts` | what changes in it | |

Every path must exist, or be explicitly marked `NEW`. Anchor each one to a real symbol
in the file — a function or exported type — so a reviewer can find the spot.

**Message contract**, if any: envelope fields touched, message name and version, the
Zod schema (`packages/schemas`), the `publish()` / `subscribe()` options that change.
**Data effects**, if any: outbox columns, the migration file under
`packages/sdk/migrations/` (existing files are immutable — add a new one), index added
in the same migration.

### Call stacks

Required when this plan adds or edits a publish path, a handler, a relay step, or a
webhook. Otherwise `N/A — {reason}`. Shape: [plan skill](../../plan/SKILL.md) § Call stacks.

| Layer | Input | Output | Errors | Side effects |
|---|---|---|---|---|
| Trust edge (publish() input / Hatchet event payload / webhook) | unparsed | validated envelope or typed payload | decode / schema | none |
| Interior | validated envelope or domain | domain | domain | outbox write / Hatchet push / consumer DB |

## 4. Flow inventory

The single most load-bearing part of this plan. Phase 2's testing sub-plan turns every
row into a test; phase 7's report reports against it.

Walk these axes and write down every combination that is actually reachable:

- **Happy path** — the intended flow, publish to handled, start to finish
- **Input space** — none, one, some, all; a batch with one bad envelope
- **Data space** — empty outbox, one row, many rows, long payloads, duplicate ids
- **Repeat** — the same envelope delivered twice; idempotency
- **Tenant** — a business tenant id set, null for a global message, a handler that opens
  its own tenant-scoped transaction from it
- **Failure** — Hatchet unreachable, the relay crashes between push and mark, a handler
  throws, partial success in a batch
- **Concurrency** — two producers at once, two handlers on the same key at once
- **Ordering** — messages sharing a concurrency key arrive out of order
- **Versioning** — a v1 consumer receives a v2 message

| # | Flow | Preconditions | Expected outcome |
|---|---|---|---|
| 1 | | | |

Four rows are **mandatory** on any plan that touches publish, relay or delivery. Never let
them be assumed:

- at-least-once redelivery of the same envelope id is idempotent
- a message published in a rolled-back transaction is never delivered
- the business tenant id on the envelope reaches the handler unchanged
- per-key ordering holds under concurrency

## 5. Acceptance criteria

Checkable assertions, each with a subject and an observable outcome. Grouped Unit /
Integration / Manual. Every flow in section 4 maps to at least one.

> Bad: "Publishing works correctly."
> Good: "`publish(tx, envelope)` inside a transaction that rolls back leaves zero rows in
> `kyu_outbox`, and the handler subscribed to that name is never invoked."

## 6. Execution steps

Ordered work units. This section is stripped out when the issue is written — it is for
the implementer, not the reader.

| WU | Does | Files | Depends on |
|---|---|---|---|

## 7. PR plan

One PR unless the diff exceeds ~400 production lines (the `check-pr-size.sh` gate) or
crosses a risk boundary (an outbox migration, the envelope contract, the relay). Each PR
independently mergeable, with its own proof.

## 8. Risks and rollback

| Risk | Likelihood | Blast radius | Mitigation | How to undo it |
|---|---|---|---|---|
```
