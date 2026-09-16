---
name: adr
description: >
  Write, scope, and supersede Architecture Decision Records in
  docs/architecture/adr/. Use when the user says /adr, "write an ADR",
  "record this decision", "should this be an ADR", "supersede ADR NNNN",
  or when a change picks a technology, sets a code pattern, fixes a
  protocol or an operational limit, and the next agent would otherwise
  have to guess why. Also use before writing a long explanatory comment
  or a docs page that is really a decision. Do not use for library
  choices, naming, lint rules, or anything a style guide or a PR
  description already covers.
---

# ADR

One decision per record. Written so someone who joins in three years,
who was in none of the meetings, can act on it.

An ADR captures **why**, not **how**. Implementation detail belongs in
code, a spike document under `docs/design/`, or the PR.

Records live in [`docs/architecture/adr/`](../../../docs/architecture/adr/).
Template: [`0000-template.md`](../../../docs/architecture/adr/0000-template.md).
Before drafting, complete the companion
[`architecture-proof-matrix.md`](assets/architecture-proof-matrix.md). Keep the
filled matrix in the parent issue, PR, or its existing planning directory; it is
working evidence, not part of the immutable ADR.

## Step 1 — Check the scope before writing

An ADR is worth writing when the choice changes the system's trajectory:
a technology or vendor, a code pattern, a communication protocol, an
operational constraint. Anything smaller is noise the next reader has to
wade through.

**Right size — write one:**

- "Write messages to a transactional outbox in the producer's database"
- "Payloads carry ids and small discriminators only"
- "Cap the relay batch at 100 rows"

**Too broad — split it:**

"Move to a message bus" is not one decision. It is the engine, then the
outbox, then the envelope contract — each its own record, in sequence.
The design document under `docs/design/` holds the whole picture; the
ADRs hold the decisions one at a time.

**Too narrow — do not write one:**

Date-formatting libraries, variable names, trailing-comma lint rules.
Those go in [`AGENTS.md`](../../../AGENTS.md), a `// safe:` comment, or
the PR description.

**The supersede test.** Ask: *if we change our minds about this in two
years, can we replace this one document without rewriting five others?*
Yes means the scope is right. No means two or more decisions are bundled
and the record will be unmaintainable.

If the answer is "this is not an ADR", say so and point at where it
belongs. That is a valid outcome of running this skill.

## Step 2 — Read the records that already exist

Before writing, check whether this ground is taken:

```bash
ls docs/architecture/adr/
grep -ril "<the technology, table, or pattern>" docs/architecture/adr/ docs/design/
```

Three outcomes, and each changes what you write:

- **An existing record already decides this.** Do not write a second one.
  Link the existing ADR and move on.
- **An existing record contradicts what you are about to decide.** You are
  superseding it — go to Step 6 first.
- **Nothing matches.** Write the new record, and cite any neighbouring ADR
  your Context depends on.

A directory of records that quietly disagree with each other is worse than
no records, because review cannot tell which one is live.

Then search beyond the ADR directory for other live architecture documents
that claim ownership of the same rule. `docs/design/kinesin-requirements-and-design.md`
already decides several things (engine, envelope, outbox shape, naming).
Record every overlap in the proof matrix and choose one disposition: reuse
the existing owner, supersede an ADR, or update a mutable document in the
same change. Do not leave two live sources quietly making the same decision.

## Step 2b — Complete the architecture proof matrix

Use the matrix to prove the decision against the system around it before
writing polished ADR prose. It must cover:

- every acceptance criterion in the parent issue
- every runtime consumer and, for changed message paths, the input type,
  output type, errors, side effects, and transaction boundary at each layer
  (caller, outbox write, relay, Hatchet, handler)
- duplicate or conflicting live documentation and ADRs
- current, transition, final, rollback, and compatibility behaviour
- explicit non-decisions, each with an owner or a fact that would reopen it

Use `rg` to find callers and competing documents. A row with no evidence is an
unknown, not a pass. Resolve blocking unknowns or state them plainly in the
parent issue before accepting the ADR.

## Step 3 — Name it

```bash
date +%Y%m%d
ls docs/architecture/adr/
```

Filename is `YYYYMMDD-kebab-title.md`. Use today's date. The date plus
the slug is the address other documents link to. Two records on the
same day are fine; they must not share a filename.

Do not mint a sequential `NNNN` prefix. `0000-template.md` is the only
file with a number, and it is the template, not a record. The date must
be a real calendar day and the `**Date:**` line must match the filename
date.

Title is short and active: `# Cap the relay batch at 100 rows`,
not "Thoughts on relay batching".

## Step 4 — Write it from the template

Copy [`0000-template.md`](../../../docs/architecture/adr/0000-template.md)
and fill it in. The sections earn their place:

| Section | What it does |
| --- | --- |
| **Status / Date / Parent** | `proposed`, `accepted`, `deprecated` (no longer applies, nothing replaced it), or `superseded by [title](YYYYMMDD-slug.md)`. The **Date:** line is `YYYY-MM-DD` and must match the filename date. Link the GitHub issue in this repo: `https://github.com/Camba-nz/kinesin/issues/N`. |
| **This is not** | The neighbouring decisions this record does not make. It stops scope creep in review. |
| **Context** | The forces, as facts. Constraints, costs, what the code does today. No solution yet. |
| **Options considered** | Each alternative in two or three sentences with its trade-off. |
| **Decision** | Active present tense. Numbered rules. |
| **Consequences** | Positive and negative, split. |
| **Do not** | The changes that contradict this, so review can link here instead of re-arguing. |
| **Reopen when** | The fact that would make this wrong. Omit if there isn't one. |

Ground every claim in something that exists — a file path, a table, a
migration under `packages/sdk/migrations/`, a section of the design
document, a Hatchet documentation page, an issue number. An ADR that
cites nothing is an opinion.

**Options considered is the section most often skipped and the one that
pays off most.** Without it, the next person cannot tell a considered
trade-off from an accident, so they redo the research or quietly
reverse the decision.

**Consequences with no negatives means the trade-offs are not understood
yet.** Every real decision costs something. Name the debt being taken on
deliberately, or keep thinking.

## Step 5 — The five checks before you commit

Rewrite if any fail:

1. **One decision.** It passes the supersede test in Step 1.
2. **Under 120 lines.** Target ~90 lines / ~550 words. Count it:

   ```bash
   wc -lw docs/architecture/adr/YYYYMMDD-your-slug.md
   ```

   Over 120 lines means implementation detail is in the wrong document.
   Move it to a spike under `docs/design/` and link it.
3. **No meeting context.** No "as we discussed", no "the team felt".
   The reader was not there and never will be.
4. **Active voice, present tense.** "We use X." Not "it was decided
   that X would be used".
5. **Proof matrix reconciled.** Every acceptance criterion has evidence; the
   runtime call stack and consumers are named where behaviour changes; overlap,
   rollout, compatibility, and non-decisions have explicit dispositions. Link
   the filled matrix from the parent issue or PR when it is not already in a
   committed planning directory.

Also run [`iso-24495`](../iso-24495/SKILL.md) over the linked issue or
PR — the same plain-language checks apply.

## Step 6 — Superseding, never editing

An accepted ADR is a historical record. It says what was true and why,
at a date. Editing it to match a new direction destroys the only reason
the file exists: someone three years out needs to know what the old
reasoning was, so they can tell whether it still holds.

When the direction changes:

1. Write a **new** ADR named `YYYYMMDD-kebab-title.md`. Its Context
   explains what changed since the old one.
2. Edit **only** the old record's status line:
   `**Status:** superseded by [new title](YYYYMMDD-new-slug.md)`.
3. Leave the rest of the old file exactly as it was, including anything
   now wrong.

## House conventions

Match the template, so new records read as one document:

- `# Title` with no sequential number.
- Bold metadata lines at the top, no YAML front matter.
- `---` rules between major sections.
- Numbered decisions with a **bold lead-in** per rule.
- Cross-reference a record by its filename, linked on first mention.
- **No task checklists.** Implementation steps and follow-ups belong in the
  parent GitHub issue, which can change state. A ticked box inside a record
  that is supposed to be immutable is a contradiction, and a stale unticked
  one is worse.
