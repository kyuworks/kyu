---
name: plan
description: Phase 2 of the feature pipeline. Produces two local planning documents — an engineering plan and a testing sub-plan covering every user flow with red-green-red evidence slots. Grounds every claim in files that exist, sizes the agent team to the complexity, and stops for approval. Use when Matt says "/plan", "plan this", "how would we build", or hands over a feature that needs designing before code. Reads a research report from planning-gitignored/research/{slug}/ when one exists. Does not implement anything.
---

# Plan — phase 2

Two documents, both derived from files that actually exist:

| Document | Path | Owns |
|---|---|---|
| Engineering plan | `planning-gitignored/plans/{slug}.md` | behaviour, non-goals, files, contracts, user-flow inventory, acceptance criteria, execution steps |
| Testing sub-plan | `planning-gitignored/plans/{slug}-testing.md` | level assignment, flow coverage matrix, red-green-red ledger |

They split because they have different readers and different lifetimes. The engineering
plan is mostly consumed in phase 4 and then stops changing. The testing sub-plan is
written in phase 2, filled with evidence in phases 3 and 5, and read in phase 7.

**Templates — read both before drafting anything:**
- [`engineering-plan.md`](.agents/skills/_pipeline/templates/engineering-plan.md)
- [`testing-subplan.md`](.agents/skills/_pipeline/templates/testing-subplan.md)

Do not improvise structure. A missing required section is an audit failure.

---

## 0 — Inputs

**Research exists** (`planning-gitignored/research/{slug}/` present): read the reconciliation artifact
and Matt's answers to its decision flow. Those answers are settled — plan to them.
Reopening a decision Matt already made is the most expensive mistake this phase can make.

**No research**: confirm the shape in one exchange before planning. If the answer needs
research, say so and route to `/research` rather than guessing across a whole plan.

Derive the slug now if it does not exist. Lowercase, hyphenated, 2–4 words, no issue
number. Every later phase keys off it.

---

## 1 — Size the team, and justify every agent

This step produces two things: a tier, and a named roster. Both go to Matt before
anything is spawned.

### 1a — Work out the tier

Score the change. Any single **Large** signal makes it Large — these are not averaged,
because one outbox migration is enough to ruin a run planned as Small.

| Signal | Small | Medium | Large |
|---|---|---|---|
| Files touched | 1–2 | 3–8 | 9+ |
| Packages crossed (schemas / sdk / infra / scripts) | one | two | three or more |
| Outbox migration or envelope contract change | none | additive — a new optional envelope field, or a new SQL file that only adds | new table, backfill, a destructive change, or an envelope field removed or given a new meaning |
| Delivery semantics (idempotency, ordering, tenant metadata) | untouched | read path only — a handler reads them, nothing changes how they are set | changes how messages are deduplicated, ordered, or how business tenant metadata is carried |
| SDK public API or envelope shape | unchanged | additive field or option | breaking change |
| Approach | obvious | one open question | genuinely unclear, or research disagreed |
| Reversibility | revert the commit | revert plus a data fix | an outbox migration already merged cannot be undone — it is immutable once on `main`, and consumers may have applied it |

Write the scoring out. One line per signal, with the actual value. "Large" with no
reasoning behind it is how a run gets three times more expensive than it needed to be.

### 1b — The rule that decides who exists

An agent earns its place only when it does one of two things:

1. **Holds context the lead must not carry.** A subagent reads twenty files and returns
   two paragraphs. The lead reads the two paragraphs. This is the main cost saving in
   the whole pipeline.
2. **Provides independence the lead cannot.** Nothing can audit its own work. An auditor
   that is also the author is a rubber stamp, and a second opinion from the same context
   is not a second opinion.

**Anything else is the lead doing it directly.** Parallelism on its own is not a reason —
two agents doing half a job each cost more than one agent doing the job, because the
lead then has to reconcile them.

### 1c — The roster

Model and effort come from the [model table](.agents/skills/_pipeline/README.md);
they are repeated here only so the roster reads as one thing.

| Agent | Job | Earns it by | Model / effort | FAST | STANDARD | FULL |
|---|---|---|---|---|---|---|
| Codebase explorer | Reads one subsystem, returns findings and file anchors | context | opus / high | 0 | 2 | 3 |
| Planner | Drafts the plan from the explorers' findings | context | opus / high | 0 | 0 — the lead drafts | 1 |
| Correctness auditor | Checks every claim in the plan against the actual files | independence | opus / high | 0 | 1 | 1 |
| Integration auditor | Checks the cross-package contracts hold end to end | independence | opus / high | 0 | 0 | 1 |
| **Phase 2 total** | | | | **0** | **3** | **6** |

For reference, what the later phases add:

| Phase | FAST | STANDARD | FULL | Why |
|---|---|---|---|---|
| 1 Research | 0 | 0 | 4 | 2 explorers, 2 reconcilers. Independence between two agents that read the code from different starting points is the entire product of that phase |
| 2 Plan | 0 | 3 | 6 | above |
| 4 Build | 0 — lead edits | 3 | 5 | one implementer per non-overlapping work unit, one reviewer per domain |
| 5 Verify | 0 | 0–1 | 0–2 | lead runs the suites; an agent only for a fix too large to hold |
| 6 Review | 1 | 2 | 2 | two passes, the second with no sight of the first's findings |
| **Total** | **1** | **8–9** | **17–19** | |

**FULL is expensive and most changes are not FULL.** If the scoring in 1a produced Large
on one signal only, say which one, and consider Medium plus the single safeguard that
signal calls for — usually the integration auditor, or the second review pass. A whole
tier up is a blunt instrument.

### 1d — Show Matt

Before spawning anything:

```
Tier: STANDARD
Why:  5 files, sdk + schemas, additive envelope field, delivery semantics untouched, approach clear
Agents: 3 in this phase, ~8 across the run
  2 × codebase explorer   packages/sdk outbox and relay, packages/schemas envelope
  1 × correctness auditor checks the plan's file claims
```

Matt can cut it. A roster Matt has seen is a roster Matt can argue with; a number in a
skill file is not.

Agent prompts are in [`agent-prompts.md`](agent-prompts.md) — use them verbatim with
placeholders filled. PR splitting rules are in [`pr-decomposition.md`](pr-decomposition.md);
read it before writing section 7.

## 2 — The engineering plan

Fill the template. The rules that get broken most often:

**Every path must exist.** Anchor each one to a real symbol in the file so a reviewer
can find the spot. `packages/schemas/src/envelope.ts` → "the `parseEnvelope` function".
Never write a plausible-looking path you did not open. This is the single most common
way a plan wastes a build.

**Non-goals name the shortcut, not the category.** Not "do not over-engineer" but "do
not add a `published` boolean to `qtaxis_outbox` — `published_at` already carries it,
and a second source of truth will drift."

**The user-flow inventory is the load-bearing section.** Walk every axis in the template.
In this repository these rows are mandatory — never let them be assumed:

- at-least-once redelivery of the same envelope id is idempotent
- a message published in a rolled-back transaction is never delivered
- business tenant id on the envelope reaches the handler unchanged
- per-key ordering holds under concurrency

## Call stacks

Required when the plan adds or edits a publish path, a subscription handler, a relay
step, or an inbound webhook. Otherwise one line: `N/A — {reason}`. A missing table on a
required path is a failed plan. Do not implement it.

| Layer | Input | Output | Errors | Side effects |
|---|---|---|---|---|
| Trust edge (`publish()` input, Hatchet event payload, or inbound webhook) | `Unparsed…` | validated envelope and typed `data` | schema validation / signature | none |
| Interior (envelope and typed data) | validated envelope and typed `data` | domain | domain | outbox insert / Hatchet push / handler side effects |

- Validate once at the trust edge — the Standard Schema validator on `publish()` and
  again on consume, where the payload comes back from Hatchet.
- Interior functions take the validated envelope and typed `data`.
- Re-parsing a value the layer above already validated is a failed plan — do not implement it.
- Side effects name the real ones (`qtaxis_outbox` insert, `events.bulkPush`,
  `qtaxis_processed` write, HTTP). `none` is allowed.

Copy the table into the engineering plan
([template](../_pipeline/templates/engineering-plan.md)).

Agents may not skip this table when the path exists. Humans may shortcut a typo PR.
The PR-body check is `scripts/gates/check-agent-ship-loop.sh`.

---

## 3 — The testing sub-plan

Written now, not in phase 5. Writing it now is what makes phase 3's RED₁ honest work
rather than a formality.

Every row of the flow inventory appears in the coverage matrix with a level and a named
test. A flow you deliberately do not automate goes in "Not automated — and why". It
never silently disappears.

**Do not fill in the commands yet** — phase 3 reads them off the project's own scripts.
Assuming `pnpm test` is the whole story is how a dead suite gets counted as a pass.

---

## 4 — Audit

Medium and Large only. Each auditor gets one planner's output and checks:

| Dimension | Question |
|---|---|
| Claim verification | Does every cited file contain what the plan says it does? |
| Coverage | Does every flow map to an acceptance criterion, and every criterion to a test? |
| Level fit | Are idempotency, rollback and ordering tested at the integration level — against the local Hatchet stack and a real Postgres — rather than a mock? |
| Decomposition | Each PR independently mergeable, own proof, under ~400 production lines? |
| Reversibility | Is the rollback in section 8 something that would actually work? |

Fold findings into the documents. An auditor's line number reaching the doc is the
normal path — that is what they are for.

---

## 5 — Gate

**Planning documents are never committed.** `planning-gitignored/` is in `.gitignore`
and stays there. They are working notes for this run — the durable record is the GitHub
issue in phase 3 and the summary artifact in phase 7, both of which are written from
these documents.

Before writing, make sure the ignore rule exists:

```bash
grep -q '^planning-gitignored/' .gitignore || printf '\n# Local planning docs — not part of the repo\nplanning-gitignored/\n' >> .gitignore
```

If `.gitignore` had to be changed, that one line is the only thing that gets committed.

Then show Matt, in this order and nothing else:

1. **Behaviour** — one sentence
2. **Non-goals** — the list
3. **Flow inventory** — the count, and the three rows most likely to be wrong
4. **PR shape** — how many, and why more than one if so

Wait for approval. This is the cheapest place in the whole pipeline to be wrong, and
the last one before code exists.

Do not roll into `/prereq`. Matt decides when to spend the build.

**Unattended** (`UNATTENDED=yes` from `.agents/skills/next/detect-stage.sh`): post the
same four things, plus the options rejected, as a decision comment on the feature issue —
[`templates/decision-comment.md`](.agents/skills/_pipeline/templates/decision-comment.md)
— then continue to `/prereq`. Rules:
[`_pipeline/unattended.md`](.agents/skills/_pipeline/unattended.md).

---

## Failure handling

An agent that cannot complete does not get retried indefinitely. Two attempts, then
report what it got and what blocked it. A wave that produces nothing usable is a stop,
not a reason to plan from imagination.

Preserve partial output — write it to `planning-gitignored/plans/{slug}-exploration.md` and say it is
partial.

## What this skill never does

- Write implementation code or tests
- Create the GitHub issue — that is `/prereq`
- Commit anything in `planning-gitignored/`
- Proceed past the gate without approval
- Cite a file it did not open
