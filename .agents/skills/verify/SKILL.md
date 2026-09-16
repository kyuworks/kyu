---
name: verify
description: Phase 5 of the feature pipeline. Drives the tests to green through two sequential fix loops (unit, then integration against the local Hatchet stack), proves the tests actually depend on the implementation by re-running them against a scratch worktree with the code removed (RED₂), audits for false positives, and publishes a manual test sheet for the flows that could not be automated. Use when Matt says "/verify", "run the tests", "prove it works", or after a build when tests exist and need to go green. Fixes code, never tests.
---

# Verify — phase 5

```
5.1  GREEN      unit → integration, in that order, each a fix loop
5.2  RED₂       scratch worktree, implementation removed, tests must fail
5.3  AUDIT      hunt false positives in the run that just passed
5.4  MANUAL     publish the sheet for what could not be automated
```

**The rule that makes this a proof:** you fix the code, never the test. A test whose
RED₁ is recorded is frozen. Cosmetic edits are still edits.

---

## 5.1 — Green, in order

Two loops, sequential. Cheapest and most localised first — a unit failure that also
breaks four integration tests should be found in two seconds, not two minutes.

| Order | Loop | Command | Move on when |
|---|---|---|---|
| 1 | Unit | `pnpm --filter <pkg> test` | exit 0, count matches the coverage matrix, zero unexplained skips |
| 2 | Integration | `pnpm hatchet:up` once, then `pnpm --filter @kinesin/sdk test:integration` | same |

`<pkg>` is `@kinesin/schemas` or `@kinesin/sdk`. Vitest is installed per package; bare
`pnpm vitest` from the root does not work. Integration tests are `*.integration.test.ts`
and run against the local Hatchet Lite + Postgres stack from `infra/hatchet/compose.yaml`.
If the stack is not up, the failure is a setup problem, not a red test — start it and
re-run before counting an iteration.

**Each iteration**: run the command. Success is silent. Failure is `FAILED`, the
first error, and a log path under `.artifacts/check/` or `.artifacts/verify/`.
Never paste a full vitest/CI log into chat. Never carry a pass claim forward from a
subagent, a previous phase, or a previous session. If you did not run it here, it
did not pass.

**Loop control** — cap at 10 iterations, or stop earlier when two consecutive iterations
produce an identical failure. An identical failure twice means you are not converging,
and further iterations are just spend. Report the blockage with real output; do not
declare success.

**Token discipline** — `pnpm check:changed` inside the loop, `pnpm check` once at the
end. Delegate a long fix to a subagent at low reasoning and have it return the diff
summary, not the file contents.

### The one escape hatch

A test may be genuinely wrong — asserting something the issue's acceptance criteria do
not require, or encoding a misreading of the contract. Then:

1. **Stop.** Do not edit it
2. Log it in the sub-plan's **test defect register** with the failing output and your reasoning
3. Put the decision to Matt

Quietly rewriting an expectation to match the behaviour you happened to produce is the
exact failure this pipeline exists to prevent. It converts a proof into a report.

### Green means

Every planned suite executed, exit code 0, count matches the matrix, and zero skipped
tests unless each skip is listed and justified. Anything less is not green, it is
"green except", and that phrase must appear in the report.

The four mandatory rows from the testing sub-plan must be among the passing tests, by
name, or the report says which are missing:

- at-least-once redelivery of the same envelope id is idempotent
- a message published in a rolled-back transaction is never delivered
- business tenant id on the envelope reaches the handler unchanged
- per-key ordering holds under concurrency

Commit. `git add -A && git commit -m "fix: green for #{NNN}"`

---

## 5.2 — RED₂

Now prove the tests depend on the implementation.

```bash
.agents/skills/_pipeline/scripts/red2-worktree.sh \
  --cmd "pnpm --filter @kinesin/sdk test" \
  --cmd "pnpm --filter @kinesin/sdk test:integration" \
  --base main
```

The filter names the package the feature touched — `@kinesin/sdk` or `@kinesin/schemas` —
and both commands must name the same package. Bare `pnpm vitest run` and
`pnpm test:integration` fail from the root: vitest is installed per package, and
`test:integration` only does real work in `packages/sdk`. The integration command needs
the Hatchet stack running (`pnpm hatchet:up`) exactly as in 5.1; the worktree talks to
the same local stack.

**How it works, and why it is safe.** It refuses to run unless the working tree is
clean, then builds a throwaway git worktree at the base commit and copies only the
committed test files into it. Your working tree is never touched — no stash, no
checkout, no revert, nothing to pop and nothing to lose if it dies half way. The
worktree is removed on exit; `--keep` keeps it for inspection.

| Exit | Meaning | Do |
|---|---|---|
| 0 | every suite failed | RED₂ proven. Record the summary and continue |
| 1 | a suite passed without the implementation | **false positive.** That test does not test the feature. Fix the test — this is the one case where editing a frozen test is required — then redo 5.1 and 5.2 |
| 2 | setup problem, or a command never ran a test — a missing script, or output with no test-runner summary in it | nothing was proven. Read the message; usually an uncommitted tree, `--install` needed because a suite cannot resolve imports through the symlinked `node_modules`, a `--cmd` that needs a `--filter`, or the Hatchet stack not running. Fix the command and re-run |

Record the summary output in the sub-plan's ledger.

### Mutation checks — optional, off by default

Only when Matt asks, or when 5.3 flags a test as weak. RED₂ proves a test depends on
the change as a whole; mutation proves the assertion actually bites. Flip the condition,
drop the idempotency check on the envelope id, publish outside the transaction, drop the
business tenant id from the envelope — the test must fail. Restore afterwards and
confirm green again.

---

## 5.3 — False-positive audit

The suite is green. Assume it is lying.

| Check | What it catches |
|---|---|
| **Count reconciliation** | Tests planned vs. tests the runner reported. A gap means a file was never collected — config `include` allowlists silently drop whole directories, and `*.integration.test.ts` files only run under the integration config |
| **Zero unexplained skips** | `.skip`, `.todo`, a conditional early `return`, an env guard that self-skips when the Hatchet stack or a token is missing |
| **Assertions that cannot fail** | `expect(true).toBe(true)`, `toBeDefined()` on something always defined, asserting on a mock's own return value, an empty-array assertion that passes because nothing was delivered |
| **Unawaited async** | A missing `await` runs the assertion after the test ends — common with publish and relay calls |
| **Over-mocking** | A test that mocks the very thing it claims to verify — a mocked Hatchet client in a test about delivery, a mocked outbox in a test about the transaction |
| **Integration test asserting on itself** | The test writes the row it then reads, or asserts on state that is the same whether or not the relay ran |

Verdict per test in the ledger: **proven** / **false positive** / **weak**.

Any false positive or weak test → fix it, then redo 5.1 and 5.2 for that test. Record
the cycle count; it goes in the phase-7 summary.

---

## 5.4 — Manual test sheet

Only when the sub-plan's "not automated" section lists rows. If it lists none, say so
explicitly and skip this step; do not publish an empty sheet.

For every row in that section:

Copy [`manual-test.html`](.agents/skills/_pipeline/templates/manual-test.html), fill
the placeholders and write one `<tr>` per flow. **Keep any edits Matt has made to
the template** — it is Matt's to evolve, and overwriting that styling is not an upgrade.

It stores verdicts in the browser only, tallies pass/fail/blocked, and has a "copy
results" button so Matt can paste the outcome back.

Write it to `planning-gitignored/plans/{slug}-manual-test.html`, publish with the `Artifact` tool, and
send it with `SendUserFile`.

---

## Gate

Report: green counts per suite, the four mandatory rows by name, RED₂ verdict, audit
verdicts, cycle count, and the manual sheet link (or "nothing manual"). Then stop —
next is a fresh high-reasoning review subagent reading the diff cold, then
`codex review` only if the `codex` CLI is on PATH (otherwise say it was not available),
then `/open-pr` if those are clean.

## What this skill never does

- Edit a test to make it pass — except a confirmed false positive, logged
- Claim "verified" without pasted output from this session
- Use `git stash` to remove the implementation
- Skip RED₂ because green looked convincing
- Let an agent claim done without this red proof (`AGENTS.md` § Agent ship loop)
