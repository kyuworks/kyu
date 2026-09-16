# Pipeline — shared reference

Eight phases. Each is its own skill, separately invocable and separately resumable.
`/ship` drives all eight end to end. `/next` detects where the work got to and runs one.
A cloud routine runs the same eight with nobody present ([`unattended.md`](unattended.md)).

| # | Phase | Skill | Produces |
|---|---|---|---|
| 1 | Research | `/research` | `planning-gitignored/research/{slug}/` — problem statement, two reports, two merges, reconciliation artifact |
| 2 | Planning | `/plan` | `planning-gitignored/plans/{slug}.md` + `planning-gitignored/plans/{slug}-testing.md` |
| 3 | Prerequisites | `/prereq` | feature issue + a sub-issue per planned PR, feature branch, failing tests (RED₁) |
| 4 | Build | `/build` | implementation commits |
| 5 | Verify | `/verify` | GREEN, RED₂, and — only when a flow is manual — `planning-gitignored/plans/{slug}-manual-test.html` |
| 6 | Review | fresh high-reasoning Claude subagent; `codex review` only if `codex` is on PATH | review findings, then the fixes |
| 7 | Wrap | `/wrap` | phase summary artifact, PR decision |
| 8 | PR | `/open-pr` | pull request against `main` — **Matt merges, never an agent** |

## Slug

One slug per feature, used by every phase. Derive it once in phase 1 or 2:
lowercase, hyphenated, 2–4 words, no issue number. `outbox-relay-batching`.

The branch is `feat/{slug}` (or `fix/{slug}`, `chore/{slug}`). The plan is
`planning-gitignored/plans/{slug}.md`. Everything keys off it.

## Planning documents are local, never committed

Everything under `planning-gitignored/` is working material for one run: problem
statements, research reports, plan documents, testing sub-plans, manual test sheets.
The folder is in `.gitignore` and stays there.

The durable record is elsewhere — the **GitHub issue** carries the design, the
acceptance criteria and, unattended, the decision comments; the **phase-7 artifact**
carries the proof. Both are written
from these files. A plan document in git rots the moment the code moves; the issue does
not, because it states intent rather than implementation.

Any phase that writes there checks the ignore rule first:

```bash
grep -q '^planning-gitignored/' .gitignore || printf '\n# Local planning docs — not part of the repo\nplanning-gitignored/\n' >> .gitignore
```

## State is derived, never stored

There is no state file. Which phase the work is at is read off the repository —
which artifacts exist, how many commits, whether a PR is open. `/next` does this with
`.agents/skills/next/detect-stage.sh`. Nothing to go stale, nothing to reconcile.

## Model and effort

**This table is the only place model and effort are decided.** Every phase skill points
here rather than restating it, so one edit changes the whole pipeline.

| Job | Phase | Model / effort |
|---|---|---|
| Research explorer | 1 | `opus` / `high` |
| Research reconciler | 1 | `opus` / `high` |
| Adversarial reviewer | 4 | `opus` / `high` |
| Codebase explorer | 2 | `opus` / `high` |
| Planner | 2 | `opus` / `high` |
| Correctness auditor | 2 | `opus` / `high` |
| Integration auditor | 2 | `opus` / `high` |
| Implementer of a specified work unit | 4 | `sonnet` / `medium` |
| Domain reviewer | 4 | `opus` / `high` |
| Review pass | 6 | `opus` / `high` |
| Fix agent | 5, 6 | `sonnet` / `medium` |
| Mechanical — file moves, collation, running suites, formatting | any | `sonnet` or `haiku` / `low` |
| Lead | all | the session model |

Two rules behind the table:

- **Judgement gets `high`; typing gets `low`.** An agent deciding what to do needs the
  effort. An agent carrying out an instruction that is already written down does not.
- **Never `max`.** It costs several times `high` and rarely changes the answer on this
  kind of work. Use it only after a `high` run has already failed to resolve something
  specific, and say why.

### Changing it

| To change | Edit |
|---|---|
| A Claude agent's model or effort | this table — the skills read it |

### Independence without a second vendor

Every agent here is Claude, so no pair of them is independent in the way two vendors would
be. Where the pipeline claims a second opinion, what it actually buys is **separate
context**: an agent that has not seen the plan, the specs, or the other agent's output.

That catches a misread file, an unexamined assumption, and work that drifted from its
brief. It does not catch something the model gets wrong the same way twice. Any phase that
rests a decision on two agents agreeing says so where Matt reads it.

Phase 6 is the one place a second vendor can help: if the `codex` CLI is on PATH, run
`codex review` after the fresh subagent and report both. If it is not, say it was not
available and rely on the subagent. Never install it, and never block on it.

### Scripts

| Script | Does |
|---|---|
| [`red2-worktree.sh`](scripts/red2-worktree.sh) | RED₂ — runs the tests against a scratch worktree with the implementation removed |
| [`red2-classify.sh`](scripts/red2-classify.sh) | decides what one RED₂ command proved: PROVEN, FALSE-POSITIVE or NOT-RUN |
| [`resolve-base.sh`](scripts/resolve-base.sh) | the base branch, `origin/main` first; sourced by `detect-stage.sh` and `red2-worktree.sh` |

Each has a colocated `*.test.sh`. Run one with `bash <path>.test.sh`.

## Token discipline

The pipeline is long. These rules are what keep it affordable — they are not optional.

- **Artifacts are the handoff, not context.** Phase N writes a file; phase N+1 reads that
  file. Never carry a research report forward in conversation so the planner can see it.
- **Subagents hold the big context.** A subagent reads twenty files and returns two
  paragraphs. The lead never reads the twenty files.
- **Grep before read.** Read a whole file only once you know which file.
- **`pnpm check:changed` in the loop**, `pnpm check` once at the end.
- **Never re-read a file you just wrote.** The edit tools error on failure; silence is success.
- **Cap the loops.** Every fix loop stops at 10 iterations, or at 2 identical consecutive
  failures. Not converging is a result — report it, do not grind.

## Language discipline

"Tested" and "verified" mean a test command ran in this session and its output is pasted.
`pnpm check`, typecheck and lint are "type-checks cleanly" and "lints clean" — never
"verified". Never carry a pass claim forward from a subagent, a previous session, or a
previous phase without re-running it.
