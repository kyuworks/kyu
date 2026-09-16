---
name: next
description: Route a feature to the right phase of the pipeline — research, plan, prereq, build, verify, review, wrap, PR — by detecting how far the work has already got. Use when Matt says "/next", "continue this", "what's next", "pick up where we left off", or hands over part-finished work without naming a phase. Use /ship instead to start a feature from scratch. Do NOT use when Matt names the phase — invoke that skill directly.
---

# Next — the router

Picks the phase, hands off, stops. Does no feature work itself.

`/ship` starts a feature and drives all eight phases. **`/next` resumes one.** Work
arrives at any point in the pipeline, and starting from the top re-does what is already
done — expensive, and it throws away real work.

Reference: [`_pipeline/README.md`](.agents/skills/_pipeline/README.md).

## Step 1 — Detect

```bash
.agents/skills/next/detect-stage.sh "<Matt's prompt>"
```

Prints `KEY=VALUE` lines. `STAGE=` is the decision; the rest is the evidence.

**The script decides, not you.** Do not override `STAGE` from your own reading of the
repository. If the detection looks wrong, say so in step 2 and let Matt choose — never
silently substitute a different phase.

## Step 2 — Confirm

Three lines, then stop:

```
Phase: verify
Why:   implementation committed on feat/outbox-relay-batching, RED₂ not yet recorded
Next:  /verify
```

Wait for a yes. **Skip this only when `HINT` is not `none`** — that means Matt named the
phase, so there is nothing to confirm — or when `UNATTENDED=yes`, where nobody can answer:
print the three lines and go on ([`_pipeline/unattended.md`](.agents/skills/_pipeline/unattended.md)).

A wrong phase costs a full agent team. Two seconds of Matt's attention is cheaper.

## Step 3 — Hand off

| `STAGE` | Invoke | Pass it |
|---|---|---|
| `research` | `/research` | Matt's prompt |
| `plan` | `/plan` | `SLUG`, and `RESEARCH` if it is set |
| `prereq` | `/prereq` | `PLAN` and `TESTPLAN` paths |
| `build` | `/build` | `PLAN` path, or the issue number |
| `verify` | `/verify` | `TESTPLAN` path |
| `review` | fresh high-reasoning review subagent; `codex review` only if `codex` is on PATH | the branch, or `PR_NUMBER` |
| `wrap` | `/wrap` | `SLUG` |
| `open-pr` | `/open-pr` | branch and issue number |
| `fix` | — | below |
| `wait` | — | below |

One skill per invocation. Do not chain into a second phase after the first returns —
come back here and re-detect, because the state has changed.

### `fix` — CI is red

Not a skill:

1. `gh pr checks <PR_NUMBER>` — find the failing job
2. `gh run view <run-id> --log-failed` — the actual error
3. Fix, run `pnpm check:changed`, push, stop

Do not open a new PR. Do not re-plan. If the failure is a design problem rather than a
broken test, say so and stop — that is Matt's decision.

### `wait` — CI still running

Report which checks are pending and **stop**. Do not poll `gh pr checks` or `gh run
watch` in this session. CI is GitHub Actions.

## Edge cases

**`STAGE=plan` with no research and the question is architectural** — the script cannot
judge that, and it will not try. Ask whether to run `/research` first. Signals worth
asking about: a choice between approaches, a subsystem nobody has touched, a change to
the envelope or the outbox migration, anything touching delivery semantics (idempotency,
ordering, retries) or how the business tenant id travels.

**Dirty tree** (`DIRTY_FILES` > 0) with `STAGE=plan` or `prereq`: say so first.
Uncommitted work usually means a build already in progress that the detection cannot see.

**On the base branch** (`BRANCH` equals `BASE`, which is `main`) with `STAGE=verify` or
later: something is wrong — verifying and shipping happen on a feature branch. Report
and stop.

**`SLUG=none`** — no branch slug and no artifact matched Matt's prompt. The artifact checks
cannot run, so detection falls back to commit shape alone. Say so; the phase may be wrong.

**Docs-only commits** (`docs/` and any `*.md`) do not count as a started build. A
committed plan or ADR still routes to `prereq`, not `verify`.

## What this skill never does

- Write code, plans, tests, or PR descriptions
- Run more than one phase per invocation
- Override the script's `STAGE`
- Proceed without confirmation when `HINT` is `none`
