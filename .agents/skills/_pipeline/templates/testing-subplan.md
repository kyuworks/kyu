# Testing sub-plan template

Written to `planning-gitignored/plans/{slug}-testing.md`. Owns red-green-red for the whole feature.

---

```markdown
# Testing: {Feature name}

**Engineering plan:** planning-gitignored/plans/{slug}.md
**Commands** — filled in at phase 3 from the project's own scripts, never assumed:

| Level | Command |
|---|---|
| Unit | `pnpm --filter @qtaxis/sdk test` (or `@qtaxis/schemas`) |
| Integration | `pnpm --filter @qtaxis/sdk test:integration` — needs `pnpm hatchet:up` first |
| Shell suites | `bash <path>.test.sh` |
| Typecheck | `pnpm --filter @qtaxis/sdk typecheck` |

## 1. Level assignment

| Level | Use it for |
|---|---|
| **Unit** | Pure logic: envelope construction, schema validation, naming rules, retry and backoff maths, batch shaping. Colocated `*.test.ts`, vitest, no network |
| **Integration (Hatchet stack)** | The SDK against the local Hatchet Lite + Postgres stack from `infra/hatchet/compose.yaml`: outbox insert inside a real transaction, rollback, relay push and mark, delivery to a handler, redelivery, per-key ordering, tenant id round-trip. `*.integration.test.ts` |
| **Manual** | Anything genuinely not automatable — a check against the Hatchet dashboard, a third-party webhook that cannot be replayed locally. Must be justified, and goes in the manual-test artifact |

## 2. Flow coverage matrix

Every row of the engineering plan's flow inventory appears here. No exceptions —
a flow you choose not to automate goes in section 5, it does not vanish.

| Flow # | Flow | Level | Test name | AC covered |
|---|---|---|---|---|
| 1 | | | | |

The four mandatory flows from the plan — idempotent redelivery, rolled-back publish never
delivered, tenant id reaches the handler unchanged, per-key ordering under concurrency —
are integration tests unless the plan says why not.

## 3. Red-green-red ledger

The rule that makes this a proof rather than a report: **every test must have been
observed failing for the right reason before it counts as passing.**

| Phase | When | What must happen | Evidence recorded |
|---|---|---|---|
| **RED₁** | Phase 3, before any implementation exists | Every new test fails **on its assertion** | The actual failure output |
| **GREEN** | Phase 5, after the build | Every test passes, count matches this matrix | The actual pass output with counts |
| **RED₂** | Phase 5, implementation removed, tests kept | Every test fails again | `red2-worktree.sh` summary |

**A test that fails on an import error, a typo, a missing fixture, or a Hatchet stack
that is not running is broken, not red.** Fix it and re-run before recording RED₁.

RED₂ runs through `.agents/skills/_pipeline/scripts/red2-worktree.sh`, which builds a
throwaway worktree at the base commit and copies only the test files into it. It never
touches the working tree. A suite that passes there is a false positive: the test does
not depend on the code it claims to cover.

| Test name | RED₁ | GREEN | RED₂ | Verdict |
|---|---|---|---|---|
| | | | | proven / false positive / weak |

## 4. Mutation checks — optional, off by default

Run only when asked, or when a test looks suspicious in the false-positive audit.
RED₂ proves a test depends on the change as a whole; mutation proves the assertion
actually bites.

| Test | Mutation applied | Did it fail? |
|---|---|---|
| | flip the condition / drop the dedupe on envelope id / drop the tenant id from metadata / return `[]` | |

## 5. Not automated — and why

| Flow # | Why not automated | How it is covered instead |
|---|---|---|

Never omit this section. An empty one is itself a claim, so write "none" explicitly.

## 6. Test defect register

The only escape hatch from frozen tests. If a test is genuinely wrong — it asserts
something the acceptance criteria do not require — it is logged here with its failing
output and the reasoning, and the decision goes to Matt. It is never quietly
rewritten to match whatever the code happens to do.

| Test | What it asserts | Why that is wrong | Decision |
|---|---|---|---|
```
