# Phase summary artifact — specification

Phase 7. Published with the Artifact tool. The last thing Matt reads before deciding
whether a PR gets opened.

## The one rule

**Plain language, and honest.** If a phase was skipped, say it was skipped. If a suite
was not run, say so. If a flow is untested, it appears here — not buried in the plan.
A summary that reads as clean when the run was not is worse than no summary.

"Tested" and "verified" appear only next to pasted output from a command run in this
session. Type-checks and lints are "type-checks cleanly" and "lints clean".

## Required sections

### 1. What you can now do

One sentence, in the words a consumer of the bus would use. Not "added relay batching"
but "a burst of a thousand events now reaches its handlers in one push instead of a
thousand".

### 2. Phase-by-phase

One row per phase that ran. Skipped phases stay in the table, marked skipped, with why.

| Phase | Ran? | What came out of it | Where it lives |
|---|---|---|---|
| 1 Research | yes / skipped — why | one line | `planning-gitignored/research/{slug}/` |
| 2 Planning | | | `planning-gitignored/plans/{slug}.md` |
| 3 Prerequisites | | issue #N, RED₁ recorded | |
| 4 Build | | N files, M commits | |
| 5 Verify | | GREEN and RED₂ results; manual sheet only if a flow was manual | |
| 6 Review | | N findings, N fixed; whether `codex review` ran | |

### 3. Proof

| Acceptance criterion | Test | Level | RED₁ | GREEN | RED₂ | Verdict |
|---|---|---|---|---|---|---|

Then the actual command output, pasted, per suite, with the command above it.

### 4. What is not covered

Carried from the testing sub-plan's "not automated" section plus anything the review
raised and did not fix. Never omit it — write "none" explicitly if that is true.

### 5. Cost

| Phase | Agents | Model / effort |
|---|---|---|

So the next run can be tuned.

### 6. The decision

End with the question, not a recommendation dressed as one:

> **Open a PR?** The branch is `feat/{slug}`, {N} commits, {M} files. It closes #{N}.
> Nothing merges without you clicking the merge button.

## Design

Load `artifact-design` before writing the page. Pasted test output is the evidence; there
is no browser run and no screenshots. Send the file with `SendUserFile` as well as
publishing it.
