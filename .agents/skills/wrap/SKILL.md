---
name: wrap
description: Phase 7 of the feature pipeline. Publishes a plain-language summary of every phase that ran in the session — what was produced, what was proven, what is still uncovered — and asks Matt whether to open a PR. Use when Matt says "/wrap", "summarise this", "what did we just do", or after review completes. Attended, it never opens the PR itself; unattended, it opens the draft. Never merges.
---

# Wrap — phase 7

One artifact, in plain language, covering the whole run. Then one question.

**Specification:** [`phase-summary.md`](.agents/skills/_pipeline/templates/phase-summary.md).
**Load `artifact-design` before writing the page.**

---

## Gather

Read from disk, not from memory of the conversation. The artifacts are the record, and
context this far into a long run is exactly where phases get misremembered as having
gone better than they did.

| Source | Gives you |
|---|---|
| `planning-gitignored/research/{slug}/` | whether research ran, what it decided |
| `planning-gitignored/plans/{slug}.md` | behaviour, non-goals, flow inventory, acceptance criteria |
| `planning-gitignored/plans/{slug}-testing.md` | the ledger — RED₁, GREEN, RED₂, verdicts, defect register, not-automated |
| `.artifacts/reviews/<branch-slug>/findings-register.md` | review findings and what was done with each, if a review loop ran |
| `git log {base}..HEAD` | commits, files touched |
| `gh issue view {feature issue}` | the acceptance criteria as written |
| `gh issue view {sub-issue}` | the slice this PR is answerable for |
| `.artifacts/check/` and `.artifacts/verify/` | the logs behind every pass or fail claim |

---

## The one rule

**Honest.** A skipped phase appears in the table marked skipped, with why. A suite that
was not run says so. A flow with no coverage appears in "what is not covered", not
buried in a plan document Matt will not reopen.

A summary that reads clean when the run was not is worse than no summary — it converts a
gap into a claim, and Matt will act on it.

"Tested" and "verified" appear only next to output from a command run in this session.
`pnpm check`, typecheck and lint are "type-checks cleanly" and "lints clean".

## Plain language

Not "the outbox relay was implemented with idempotent redelivery" but "a message written
in a transaction that is rolled back is never sent, and a handler that receives the same
message twice does the work once".

Every technical term gets its meaning in the same sentence. Tables for anything being
compared. Bold labels, blank lines between groups. Matt reads on screen, fast.

---

## Publish

1. Write the page, publish with `Artifact`, send the link
2. `SendUserFile` the HTML as well
3. `PushNotification` with the one-sentence summary plus the headline numbers —
   `N/N green, RED₂ proven, M flows manual`

## Then ask

End with the question, not a recommendation dressed as one:

> **Open a PR?** Branch `feat/{slug}` → `main`, {N} commits, {M} files. Closes #{N}.
> You merge — nothing merges without you clicking the button.

Wait. `/open-pr` is a separate decision, and phase 8 is Matt's.

**Unattended** (`UNATTENDED=yes` from `detect-stage.sh`): do not ask. Open the draft
against `main` with `/open-pr`, post the summary link and every decision comment on the
feature issue, stop.
Rules: [`_pipeline/unattended.md`](.agents/skills/_pipeline/unattended.md).

## What this skill never does

- Open the PR while a person is present — that is Matt's yes, not this skill's
- Merge anything, ever, under any instruction that did not come from Matt in chat
- Report a phase as clean when its artifact says otherwise
- Omit the "not covered" section — "none" is written explicitly when true
