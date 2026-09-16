# PR Decomposition

Applied during **Phase 4.5** of the plan skill, after the integration audit and before final synthesis. Defines how Work Units are grouped into right-sized, independently-shippable PRs.

## When to split

Size by **risk and blast radius, not a line count** — the hard cap is separate: `scripts/gates/check-pr-size.sh` fails a PR over 400 net production lines unless a human adds the `oversized-justified` label and reason. Split at a natural seam when ANY of the following is true:

- The plan **mixes packages** (schemas + sdk + infra) or **bundles a refactor** with a feature — split at those seams (refactor first).
- The plan has **independently-testable milestones** (e.g., "outbox insert done" vs "relay done").
- A WU touches a **high-risk surface** — an outbox migration (`packages/sdk/migrations/*.sql`), the envelope contract, delivery semantics (idempotency, ordering, business tenant metadata), destructive ops, or the publish/relay path — keep that WU in its own small, isolated PR.
- A WU spreads across **>3 production modules** (a screening trigger — uniform mechanical sweeps are exempt).
- The **active-code diff** (changed prod lines, excluding generated files, tests, and non-prod/support) is more than a reviewer can hold in one sitting.

If none apply, a single PR is fine. Larger PRs are acceptable when risk is contained — **option-gated dark code (an SDK option that defaults off), test-heavy, non-prod/support, or a uniform mechanical sweep**. Default to fewer PRs when cohesion is high — don't split for the sake of splitting, and don't force a small vertical slice into artificial package-only splits.

## How to split

Group Work Units into PRs following these rules in order:

1. **Package boundaries first.** An outbox migration is its own PR — the SQL file under `packages/sdk/migrations/` and its README note only, never bundled with the SDK code that depends on it. `packages/schemas` (envelope, naming, schema adapters) is its own PR when `packages/sdk` also changes. `packages/sdk` is its own PR. `infra/` and `scripts/` ride alone. Shared types ride with whichever package consumes them first.
2. **Refactor before feature.** Refactors that enable the feature go in an earlier PR so feature PRs stay small and reviewable on their own.
3. **Independence first; then dependencies drive order.** When WUs don't depend on each other, give each its own PR off `main` — parallel review, its own merge clock; don't stack for convenience. When there *is* a real dependency, PR-N+1 either **chains** off PR-N's branch (still concurrent — that chaining is the `stacked` strategy) or waits and branches off fresh `main` after PR-N merges (`sequential`). **Migration PRs always stack on one chain, never double-branch:** if another migration PR (this plan's or one already open in the repo) is unmerged, base the next migration PR on that branch, not on `main`. Migration files are immutable once merged (`scripts/gates/check-migration-immutability.sh`) and consumers apply them in file-name order, so the order has to be right the first time; one linear chain fixes it once.
4. **Each PR must be independently reviewable.** A reviewer should understand what the PR does without reading the others. If a PR only makes sense in context of another, merge them.
5. **Each PR must have its own proof.** One pasted test run (unit or integration) or one assertions table per PR. There is no UI, so there are no screenshots. No PR ships without proof.
6. **Size per PR is risk-driven, measured in active-code diff** (prod lines, excluding generated / tests / non-prod). Keep high-risk PRs (migration, envelope contract, delivery semantics, publish/relay path) small and isolated; an option-gated / non-prod / test-heavy / mechanical-sweep PR may be larger. If a single WU is too big for its risk, split that WU first. The 400-line gate still applies and is separate.

## Stacked or sequential

**Default to `stacked` with each PR independent off `main`** — chain a PR on a parent only for a genuine build dependency (or a migration, which must stack).

> **`stacked` names the strategy, not the act.** The `stacked` *strategy* is a concurrent batch — all PRs open at once and review in parallel. Within it you *stack* (chain a PR off a parent) **only** when a real dependency forces it; otherwise each PR branches off `main`. So "stack **only** for a genuine dependency" is the rule that governs the *act* of stacking *inside* a stacked batch — the strategy name and the rule are consistent, not in tension.

- **Stacked** (the default — concurrent): all PRs are opened now and reviewed in parallel. Each PR after PR-1 branches off **`main`** (independent — no chain, no rebase, merges on its own clock; reach for this first) **or**, only for a genuine build dependency (or a migration), off its **parent PR's branch** (chained — the reviewer sees the chain, it needs rebasing when a lower PR is amended, and Matt **merges only the bottom** to `main`, never a child into its parent). Mix freely within one plan: independent where you can, chained where you must; keep the bottom flowing and fix forward.
- **Sequential** (one PR at a time): PR-N ships and merges to `main`, then PR-N+1 builds off fresh `main`. Use only when PR-N+1 genuinely can't be built until PR-N has landed — phased rollouts / high-risk changes.

The approval gate at the end of planning presents the fitting option(s) to Matt.

## Plan Document: PR Plan section

Every plan that passes Phase 4.5 MUST include a `## PR Plan` section placed immediately after `## Approach` and before `## Work Units`:

```markdown
## PR Plan

**Total estimated change:** ~{LOC} across {N} files → split into {M} PRs.
**Strategy:** {stacked | sequential}

### PR-1: {scope in 3-6 words}
- **Work Units:** WU-1, WU-2
- **Active-code diff:** ~{N} lines / {files} (excl. generated / tests / non-prod)
- **Branches off:** main
- **Depends on:** none
- **Proves:** {one sentence — what a reviewer can verify in isolation}
- **Proof artifact:** {pasted test run / assertions table description}

### PR-2: {scope}
- **Work Units:** WU-3
- **Active-code diff:** ~{N} lines / {files} (excl. generated / tests / non-prod)
- **Branches off:** main (independent) | PR-{k}'s branch (chained — real dependency only) | main after PR-{k} merges (sequential)
- **Depends on:** none (if independent) | PR-{k} (if chained or sequential)
- **Proves:** {...}
- **Proof artifact:** {...}
```

## Closing a PR Plan (shape-aware)

How a PR Plan closes depends on the work's **shape**. Do not bolt a flip gate onto work that never flips, and do not drop per-PR verification from work that ships live.

A "flag" in this repository is an SDK option that defaults off, or a config value under `infra/`. There is no runtime flag service.

**Shape A — option-gated feature.** The PR Plan **ends with an integration PR, then a flip-readiness gate**, after the feature PRs —

- **Integration PR** — implement integration tests (`*.integration.test.ts`, run against the local Hatchet stack) for the *assembled* feature (happy path + key edges), run with the option ON. Depends on all feature PRs.
- **Flip-readiness gate** (the final step) — run the full integration suite (`pnpm --filter @kinesin/sdk test:integration`) + a **manual flip-readiness pass + Matt's signoff** against the whole feature *behind the option*, and fix what surfaces. This produces a **GO to flip** — a deliberate, separate release step (a PR that changes the default, or a config change), **not** one of the feature's code PRs. Depends on every feature PR **and** the integration PR. When the option lives in this one repository, the integration and flip gates **collapse** into one combined gate.

Building behind an option is *why* the feature PRs can each be larger (dark code can't affect live consumers).

**Shape B — unflagged, live on merge.** There is **no flip gate** — each PR is live for consumers the moment it merges and a release is cut, so verification is **per PR before merge** (manual verify + test where the PR changes what a consumer sees, or sits on the publish/relay/handler path; Matt's signoff case-by-case where the public API changes) and rides on each PR's own proof, not a closing gate. You *may* add one end-of-plan integration PR as **regression insurance — not a release gate**. If the work changes consumer-visible behaviour and *could* sit behind an option that defaults off, **do that** (→ Shape A).

**Shape D — no live behaviour change** (refactor / tooling / docs / CI / scripts). No flip gate; keep a final verification pass (`pnpm gates` + targeted automated tests).

## WU-to-PR assignment rules

- Every WU MUST be assigned to exactly one PR in the PR Plan.
- A WU cannot span two PRs. If it needs to, split the WU first.
- If two WUs must ship together for correctness, they belong in the same PR.
- If a WU's files are imported by another WU's files, the consumer's PR depends on the producer's.
- Each WU entry in `## Work Units` MUST include a `**PR:**` field naming its assigned PR (e.g., `**PR:** PR-1`).

## Audit dimension

Add this dimension to the correctness-audit pass when a PR Plan is present:

| Dimension | What to Check |
|-----------|---------------|
| **PR decomposition sanity** | Is each PR independently mergeable? Can a reviewer approve each PR in <10 min without reading the others? Does each PR have its own proof? Is each PR **sized for its risk** — high-risk (migration / envelope contract / delivery semantics / publish-relay path) kept small and isolated, larger only when option-gated / non-prod / test-heavy / mechanical? Do dependencies form a clean chain (no diamond deps)? Are independent WUs actually split into independent PRs off `main` (not chained on a parent for convenience)? If a PR is large, is there a stated reason (and does it carry `oversized-justified`)? Does the plan **close correctly for its work shape** (see Closing a PR Plan)? Shape A: an integration PR + a flip-readiness/signoff gate (a separate release step, not a code PR; option in this one repository → collapsed into one). Shape B: **no** flip gate — per-PR verification rides on each PR's own proof. Shape D: a final verification pass. Is any consumer-visible unflagged (Shape B) plan one that *should* have been option-gated (→ Shape A)? |

The integration auditor should spot-check the PR Plan specifically — verify that each PR's "Proves" claim is actually achievable with only that PR's WUs.

## When the decomposition fails audit

If the correctness auditor flags any PR as too large, non-reviewable, or missing proof:

1. Re-group WUs — usually means splitting a package PR further (e.g., "outbox insert" + "relay loop" instead of "sdk").
2. If a single WU is the culprit, return to Phase 2 (Planning) and split that WU into two.
3. Re-run the PR decomposition audit on the revised plan.

Do NOT proceed to Phase 5 with a PR Plan that has unresolved decomposition findings.
