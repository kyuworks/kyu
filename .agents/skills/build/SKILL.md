---
name: build
description: Use when implementing any multi-step feature, bugfix, or task that would benefit from parallel agents. Lead coordinates only — never edits code. Implementation agents do the work in parallel; one review agent per domain (schemas/sdk/infra/scripts/docs) reviews all WUs in that domain. After commit, a Claude Opus agent that has seen none of the build reviews the diff; the lead summarises findings and proposes amendments; the user decides what to apply; fix agents apply approved changes; the review re-runs. Loop is user-driven (no automatic cap). On user acceptance, commit + push and offer a PR back to main. /verify is optional based on user direction.
---

# Build

## Overview

Every non-trivial task is executed by an **agent team**. The lead (you) coordinates and never edits files — implementation agents do all the work, domain reviewers verify it, a Claude Opus agent that has seen none of that reviews the committed diff, and fix agents apply user-approved changes.

```
Layer 1: IMPLEMENTATION agents       (do the work, one per WU)
Layer 2: DOMAIN REVIEW agents        (one per domain touched — covers correctness + integration + conformity)
[Lead commits all changes]
Layer 3: ADVERSARIAL REVIEW            (Claude Opus, fresh context, diff vs {base_branch})
Layer 4: LEAD analysis + user gate    (lead summarises findings, proposes amendments, user decides)
Layer 5: FIX agents                   (apply user-approved fixes; lead never edits)
[Re-run the adversarial review; loop to Layer 3 — no cap, user is in the loop]
[On user acceptance] Commit + push, offer PR to main, optionally /verify
```

## When to Use

**ALWAYS use when:**
- Implementing any feature, bugfix, or task with 1+ work units that touch more than one file
- Fixing bugs that touch multiple files/systems
- Writing tests + implementation together
- Any task where you'd otherwise use parallel agents
- Even single-WU tasks that are non-trivial (e.g., a bug fix touching 2-3 files, a new component with tests)

**Do NOT use when:**
- Single-file trivial change (typo fix, one-liner, rename, adding one log line)
- Pure research/exploration with no code changes
- The user explicitly says to skip auditing

**Decision rule:** If the change touches more than one file OR requires more than 10 lines of new logic, use build.

## Lead Coordinator Rule (NON-NEGOTIABLE)

**The lead NEVER edits files.** This applies through every phase of this skill — initial implementation, audit-fix application, review-fix application, post-acceptance cleanup. All code changes go through spawned agents (Task with `team_name`).

The lead's job is exclusively:
- Decompose the work and create the team
- Spawn agents and hold them to the plan
- Read and summarise agent reports
- Spawn the adversarial reviewer and parse its output
- Present its findings and proposed amendments to the user
- Spawn fix agents to apply user-approved changes
- Run git commands (status, diff, commit, push, branch creation, PR creation)

**The lead's job is to ensure the plan is implemented as designed.** If that is not possible, refer to the architecture and design of the plan, and make the minimum change to implement the plan's objectives. "Shims", "Skipped Tests" or "Copy and Pastes" are never acceptable.

## Team Sizing

Number of implementation agents = number of work units. Number of review agents = number of domains touched. There is no per-WU auditor — reviewers are per-domain.

| Feature Size | Work Units | Domains Touched | Total Agents (excl. fix agents) |
|-------------|-----------|----------------|--------------------------------|
| **Small** (1 WU) | 1 | 1 | 2 (1 impl + 1 review) |
| **Medium** (2–3 WUs) | 2–3 | 1–3 | 3–6 |
| **Large** (4–6 WUs) | 4–6 | 2–4 | 6–10 |
| **Very Large** (7+ WUs) | 7+ | 2–5 | 9–12 |

**Domains** are the top-level areas of the codebase that have their own conventions. In this monorepo:

| Domain | Paths |
|---|---|
| `schemas` | `packages/schemas/` — the `@kyuworks/schemas` package: envelope, event and command schemas (Zod) |
| `sdk` | `packages/sdk/` — the `@kyuworks/sdk` package: publish, outbox, relay, subscribe, and the outbox migration under `packages/sdk/migrations/` |
| `infra` | `infra/` (the Hatchet compose stack), `.github/` (CI) |
| `scripts` | `scripts/` (check, gates, hooks), `oxlint-rules/`, `.agents/` (skills) |
| `docs` | `docs/` (design, architecture, ADRs) |

Add a domain when a WU touches a path not listed here (for example a new `examples/*` package).

If a single WU touches multiple domains, count each domain it touches. The reviewer for that domain reviews the WU's changes within that domain only.

**How to determine work unit count:**
- Each WU = one logical unit of work, implementable and verifiable independently
- A WU typically touches 1–4 files in the same area/module
- If two changes MUST happen atomically (e.g., interface + implementation), they're ONE WU
- If two changes CAN be implemented and tested independently, they're TWO WUs
- Fewer larger WUs is better than many tiny ones

**Hard boundaries:**
- Minimum: 1 WU (still gets a domain reviewer)
- Maximum: 10 WUs per build. If a feature needs more, split it into multiple build invocations with clear interface contracts between them.

## Project Verification Commands

Before spawning any agents, set the verification commands for the packages the WUs touch. ALL agent prompts MUST use these commands instead of hardcoded values.

This is a pnpm workspace. Commands target one package by filter. `<pkg>` is the package the WU touched: `@kyuworks/schemas` or `@kyuworks/sdk`.

| Variable | Command | Notes |
|---|---|---|
| `{compile_check}` | `pnpm --filter <pkg> typecheck` | `tsc --noEmit` for that package |
| `{lint_check}` | `pnpm --filter <pkg> lint` | oxlint; every rule is `error` |
| `{test_check}` | `pnpm --filter <pkg> test` | vitest unit tests. Integration tests are `pnpm --filter @kyuworks/sdk test:integration` and need the Hatchet stack (`pnpm hatchet:up`) |
| whole tree | `pnpm check:changed` | quiet, scoped to changed files. Silent on success; on failure prints `FAILED`, the first error, and a log path under `.artifacts/check/` |

Vitest is installed per package. Bare `pnpm vitest` from the repo root does not work. For a WU outside the packages (`scripts/`, `infra/`, `docs/`), `{test_check}` is `pnpm gates` (runs `scripts/gates/*.sh` self-tests) and `{compile_check}` is `pnpm check:changed`.

**Rule:** Set `{compile_check}`, `{lint_check}`, `{test_check}` ONCE during Phase 1, per package, then pass them as variables in every agent prompt. Never hardcode a command in an agent prompt.

## Teammate Requirement (NON-NEGOTIABLE)

**ALL agents in the build skill MUST be proper teammates** — created via `TeamCreate` + `Task tool with team_name`. NEVER use standalone `Task` calls without `team_name`. This applies to:
- Implementation agents
- Domain review agents
- Fix agents (adversarial-review fixes, domain-review fixes)

**RIGHT:** `TeamCreate` first, then `Task` with `team_name` parameter for every agent.
**WRONG:** `Task` tool without `team_name` — creates an isolated subagent with no coordination, no shared task list, no visibility.

## The Architecture

```
                    LEAD (you — coordination only, no edits)
                         |
          +--------------+--------------+
          |              |              |
     impl-alpha    impl-beta     impl-gamma            LAYER 1: Implementation (one per WU)
          |              |              |
          +------+-------+------+-------+
                 |              |
          review-schemas   review-sdk                  LAYER 2: Domain Review (one per domain)
                 |              |
                 +------+-------+
                        |
                  [LEAD commits]
                        |
             adversarial-review                       LAYER 3: Claude Opus, fresh context
                        |
              [LEAD analyses + proposes]                LAYER 4: Lead summary + user gate
                        |
                  [USER decides]
                        |
                   fix-agent(s)                         LAYER 5: Fix agents apply approved changes
                        |
          [Re-run adversarial review] ←── (loop, no cap, user-driven)
                        |
              [USER confirms acceptance]
                        |
              [LEAD commits + pushes, offers PR + optional /verify]
```

### Layer 1: Implementation Agents
- Do the actual coding/testing work
- Each agent gets ONE focused WU with a clear spec
- Work in parallel when WUs are independent
- Must mark their task as completed when done

### Layer 2: Domain Review Agents
- **One reviewer per domain touched.** The `schemas` reviewer covers all WUs that touched `packages/schemas/`; the `sdk` reviewer covers all WUs that touched `packages/sdk/`; etc.
- **Combined remit** — each domain reviewer covers what the previous 4-layer model split into correctness + integration + conformity, but scoped to its own domain.
- Reads the spec for every WU that touched its domain (the spec IS the audit contract)
- Verifies the implementation matches the spec point-by-point
- Traces imports/call sites within its domain for side effects
- Runs the project's verification commands (`{compile_check}`, `{test_check}`)
- Checks conformity to existing patterns in its domain (naming, dependencies, architectural patterns, error handling, imports/exports, configuration)
- Checks for duplicated functionality (a new function, class, schema, gate, or skill that already exists)
- Reports findings with exact file paths and line numbers
- Blocked until ALL implementation tasks that touched its domain are completed

### Layer 3: Adversarial Review — Claude Opus
- After all implementation work is committed, the lead spawns **one Claude Opus agent at `high` effort**, in a detached worktree
- The lead gives it the diff against `{base_branch}` and nothing else — no plan, no work-unit specs, no domain-review findings
- Withholding those is the point. A reviewer told what the code was meant to do reads the diff looking for that and confirms it
- Opus shares the implementers' blind spots, so it earns its place by reading the diff cold, not by being a different model
- Output is captured by the lead for the next layer

### Layer 4: Lead Analysis + User Gate
- Lead reads the reviewer's output and produces a summary for the user containing:
  - Each finding (severity, file, line, what the reviewer said)
  - Lead's assessment (agree / disagree / partial — with reasoning)
  - Proposed amendment per finding (concrete code change OR "no change recommended")
- Lead presents this to the user and STOPS
- **User decides which proposed amendments to apply.** Lead never auto-applies.

### Layer 5: Fix Agents
- For each amendment the user approves, lead spawns a fix agent (Task with `team_name`) with the specific change to make
- Fix agents are bounded — they do ONLY the approved change, nothing else
- Lead never edits files directly

### Review Loop
- After fix agents complete, lead commits the fixes and spawns a **new** Claude Opus agent — never the same one, which would defend its earlier findings
- Loop back to Layer 4 (lead analysis → user gate → fix agents)
- **No automatic cap.** The user is in the loop and decides when to stop.
- The user signals acceptance with explicit confirmation — then proceed to push + PR + optional /verify

## Execution Protocol

### Phase 0: Review the plan + confirm base branch (interactive)

Before any team creation:

1. **Read the plan.** Locate the plan document (`planning-gitignored/plans/{slug}.md`) or the issue body if no plan doc exists.
2. **Clarify any issues with the user.** Ambiguities, missing detail, contradictions — surface them and resolve before proceeding. Do NOT invent answers.
3. **Confirm the base branch.** Unless the user has already specified one in this conversation, ask:

   > "What branch should I base this work off and target the final PR at? (default: main)"

   `main` is the only long-lived branch. There is no `develop`.

   Verify the branch exists on the remote:
   ```bash
   git fetch origin
   git rev-parse --verify origin/{base_branch}
   ```
   If it does not exist, stop and ask. Do not silently fall back.

4. Record `{base_branch}` and use it in all downstream phases (feature branch creation, adversarial review base, final PR target).

### Phase 1: Decompose the Work

Before creating the team, you MUST:

1. **Understand the full scope** — Read relevant files, understand the codebase
2. **Determine the project type** — Set `{compile_check}`, `{lint_check}`, `{test_check}` for this project
3. **Identify independent work units** — Each unit becomes one implementation task
4. **Define the spec for each unit** — This spec IS the audit contract
5. **Identify dependencies** — Which tasks block which others?
6. **Identify domains touched** — For each WU, list which domains its files belong to. Aggregate into a unique list of domains. Each domain gets one reviewer.
7. **Identify codebase reference files per domain** — Find the files that define each domain's conventions for the domain reviewer. Look for:
   - Utility/helper directories within that domain (`lib/`, `utils/`, `helpers/`)
   - Existing modules similar to what's being built (the closest precedent)
   - Config files that define patterns
   - Store as `{reference_files_for_domain_X}` — passed to that domain's reviewer
8. **State the pre-creation search rule** — So implementation agents search before creating duplicates. The three searches are fixed for this repo:
   - Before adding a function, class, or schema: search `packages/*/src` for an existing export
   - Before adding a gate: search `scripts/gates`
   - Before adding a skill: search `.agents/skills`
   - This rule goes into EVERY implementation agent prompt AND every domain reviewer prompt

### Phase 2: Create Team and Tasks

```
1. TeamCreate with descriptive name
2. For each work unit N, create:
   - Task impl-N: "Implement [description]"
3. For each domain D touched, create:
   - Task review-D: "DOMAIN REVIEW ({D}): Verify all WUs that touched {D}"
4. Set dependencies:
   - review-D is blockedBy ALL impl-N tasks where WU-N touched domain D
   - Cross-WU deps as needed (e.g., impl-B blockedBy impl-A)
```

### Phase 3: Spawn Implementation Agents (Wave 1)

Spawn all independent implementation agents in parallel:

```
Task(impl-alpha, team_name="{team}") — runs immediately (no blockers)
Task(impl-beta, team_name="{team}")  — runs immediately (no blockers)
Task(impl-gamma, team_name="{team}") — blocked by impl-alpha (spawned after alpha completes)
```

**REMINDER:** Every Task call MUST include `team_name`. A Task without `team_name` creates a standalone sub-agent — invisible to the team, no shared task list, no coordination. This is NEVER acceptable in build.

**Agent naming convention:** `impl-{name}` where name describes the work unit.

**Every implementation agent prompt MUST include:**
- The team name (`team_name` parameter)
- A unique agent name (`name` parameter)
- The task ID to claim and complete
- Full context needed to do the work (file paths, API contracts, patterns)
- Clear acceptance criteria
- The project's verification commands (`{compile_check}`, `{lint_check}`)
- Instruction to mark their task completed via TaskUpdate

### Phase 4: Spawn Domain Review Agents (Wave 2)

When all implementation tasks that touched a given domain are complete, spawn that domain's reviewer:

```
All impls touching schemas complete -> spawn review-schemas (Task with team_name="{team}")
All impls touching sdk complete     -> spawn review-sdk     (Task with team_name="{team}")
```

Domain reviewers can run in parallel once their respective blockers clear.

**Every domain review agent prompt MUST include:**
- The list of WU task IDs that touched this domain (for reading specs)
- The list of files changed in this domain across those WUs
- The `{reference_files_for_domain}` for this domain
- The project's verification commands
- The combined review dimensions (see Domain Review Agent Template below)
- Instruction to report findings with exact file paths and line numbers
- Instruction to mark its task completed via TaskUpdate

### Phase 5: Resolve Domain Review Findings

After domain reviewers complete:

1. **Collect all findings** across all domain reviewers
2. **If issues found:** Spawn targeted fix agents (Task with `team_name`). Lead never edits.
3. **If fixes are non-trivial:** Re-run the relevant domain reviewer on the fixed code
4. **If all clean:** Proceed to Phase 6

### Phase 6: Commit All Changes

Lead commits the agents' work to the feature branch:

```bash
git status
git diff --stat
git add {paths}
git commit -m "{conventional message — describe the WUs collectively}"
```

Lead does not edit files in this step — only stages and commits what the agents produced.

### Phase 7: Adversarial Review

Lead spawns **one Claude Opus agent at `high` effort** against the committed diff, with no
knowledge of how the work was built. See the Adversarial Review Agent Template below.

The lead passes the diff and the base branch. It passes **no** plan, no work-unit specs,
no domain-review findings, and no summary of what the feature is meant to do.

Capture the reviewer's output for the next phase. If it returns nothing usable, surface
that to the user rather than treating an empty review as a pass.

### Phase 8: Lead Reviews Findings + Proposes Amendments

Lead reads the reviewer's output and produces a structured summary for the user:

```
=== ADVERSARIAL REVIEW (iteration {i}) ===

Finding 1: {short title}
  Severity: {reviewer's severity}
  Location: {file}:{line}
  Reviewer says: {quote}
  My assessment: {agree | disagree | partial} — {reasoning}
  Proposed amendment: {concrete change OR "no change recommended"}

Finding 2: ...

=== END FINDINGS ===

Awaiting your decision on each finding.
```

Lead STOPS here. No fixes applied yet.

### Phase 9: User Decision Gate

Wait for explicit user direction on each finding (e.g., "apply 1 and 3, skip 2", "apply all", "skip all"). Do NOT proceed without explicit user input.

### Phase 10: Spawn Fix Agents for Approved Amendments

For each user-approved amendment, spawn a fix agent:

```
Task(fix-{n}, team_name="{team}", prompt=<Fix Agent Template with the specific change>)
```

Fix agents are bounded — they do ONLY the approved change. Lead never edits files directly.

After fix agents complete, lead commits the fixes:

```bash
git add {paths}
git commit -m "fix(review): {summary of applied amendments — iteration {i}}"
```

### Phase 11: Re-review (loop to Phase 7)

Spawn a **fresh** Claude Opus agent against the new diff — not the previous one. Loop back through Phase 8–10. **No automatic cap** — the user is in the loop and signals when to stop.

### Phase 12: User Confirms Acceptance

When the user explicitly confirms acceptance ("ship it", "we're good", "accepted", etc.), proceed.

### Phase 13: Push + Offer PR (+ optional /verify)

```bash
git push -u origin {feature_branch}
```

Then offer the user:
1. Create a PR back to `{base_branch}`? (yes/no)
2. Run `/verify` against the feature? (yes/no — only proceed if explicitly requested)

If the user wants the PR, create it with `gh pr create --base {base_branch}` (see `/open-pr`). If the user wants `/verify`, invoke it. Neither is automatic.

**Unattended** (`CLAUDE_CODE_REMOTE=true`): there is no user to ask. Push, then open a draft with `gh pr create --draft --base main`. `scripts/hooks/agent-guard.sh` denies a non-draft PR and a PR without an explicit `--base`. Never merge. Matt merges.

## Task Dependency Graph Template

For a feature with 3 work units (A schemas, B sdk, C sdk; B depends on A):

```
impl-A (schemas)  ──────────► review-schemas  ────┐
   |                                               │
   ▼                                               │
impl-B (sdk) ──┐                                   │
               ├─► review-sdk ─────────────────────┤
impl-C (sdk) ──┘                                   │
                                                   ▼
                                       [Lead commits, runs review]
```

Dependencies:
- `impl-B` blockedBy `impl-A`
- `review-schemas` blockedBy `impl-A`
- `review-sdk` blockedBy `impl-B`, `impl-C`

## Agent Prompt Templates

### Implementation Agent Template

```
You are "{name}" on team "{team}". Your task is Task #{id}: {subject}.

Read task #{id} details with TaskGet, then implement it.

Key context:
- [File paths and what to modify]
- [API contracts or interfaces to implement against]
- [Existing patterns to follow]
- [Specific acceptance criteria]

MANDATORY — NO DIVERGENT CREATION:
Before creating ANY new file, function, class, schema, gate, or skill, you MUST
first search the existing codebase for equivalents. If functionality already exists
(even under a different name or in a different file), USE IT — do not create a duplicate.

Pre-creation search checklist:
- Before adding a function, class, or schema: search `packages/*/src` for an existing export
- Before adding a gate: search `scripts/gates` for an existing gate that checks the same thing
- Before adding a skill: search `.agents/skills` for an existing skill that covers it
- If the spec names a helper or schema and the codebase already has an equivalent that
  does the same job, use the existing one — do NOT create a second one

Creating a duplicate of existing functionality is a build failure — the domain reviewer
will flag it as MUST FIX and the work will be sent back for correction.

After implementing:
- Verify project builds: `{compile_check} 2>&1 | head -30`
- Run lint: `{lint_check} 2>&1 | head -30`
- Mark task #{id} as completed via TaskUpdate
```

### Domain Review Agent Template

```
You are "{name}" on team "{team}". Your task is Task #{id}: DOMAIN REVIEW ({domain}).

You are the single reviewer for the {domain} domain on this build. You cover what
would otherwise be split across correctness, integration, and conformity audits — but
scoped to changes within the {domain} domain only.

STEP 1: Read the specs of every WU that touched this domain:
{list of impl task IDs to read via TaskGet}

STEP 2: Read the codebase reference files that define {domain} conventions:
{reference_files_for_domain}

STEP 3: Read the actual changed files in this domain:
{list of files changed within this domain}

STEP 4: Verify on every dimension below. Report findings with exact file paths and line numbers.

CORRECTNESS dimensions (does the code do what the spec says?):
| Dimension | What to check |
|-----------|---------------|
| Spec compliance | Does output match every point in each task's spec / acceptance criteria? |
| Code quality | No type-safety bypasses (`any`, `# type: ignore`, `unsafe`), no hardcoded values |
| Build verification | Run `{compile_check} 2>&1 | head -30` — clean? |
| Completeness | Nothing half-done, no TODOs left behind |
| Logic correctness | No bugs, off-by-one errors, missing error handling |

INTEGRATION dimensions (does the change fit the rest of the {domain} domain?):
| Dimension | What to check |
|-----------|---------------|
| Call site tracing | Grep for ALL imports/usages of changed modules within {domain}. Every call site accounted for. |
| Side effect analysis | Do changes to module X affect modules Y, Z within {domain} that import it? |
| Test suite health | Run `{test_check} 2>&1 | head -50` — do all tests in {domain} still pass? |
| Cross-cutting concerns within {domain} | Envelope shape, outbox and relay contracts, subscription registration, business tenant metadata passing through unchanged |

CONFORMITY dimensions (does the new code belong in this {domain}?):
| Dimension | What to check |
|-----------|---------------|
| Existing functionality | Does the new code reimplement something that already exists in {domain}? Search `packages/*/src` exports, `scripts/gates`, `.agents/skills`. Duplicates are MUST FIX. |
| Naming conventions | Do new names match the style used elsewhere in {domain}? |
| Dependency consistency | Any new imports that duplicate what an existing dependency in {domain} already does? |
| Architectural patterns | Does the code structure match similar existing modules in {domain}? |
| Error handling style | Does error handling match the {domain} convention? |
| Import/export patterns | Do imports follow the established style in {domain}? |
| Configuration patterns | Are constants, env vars, config values handled consistently with {domain}? |

For each finding, classify:
- MUST FIX: broken, wrong, or duplicates existing functionality
- SHOULD FIX: pattern/style violation backed by demonstrable precedent in {domain}
- CONSIDER: minor drift, not wrong but inconsistent

Only flag deviations backed by demonstrable codebase precedent in this domain. Do NOT
flag subjective preferences or compare to other domains.

Mark task #{id} as completed when done.
```

### Fix Agent Template

```
You are "{name}" on team "{team}". Your task is Task #{id}: FIX ({short description}).

The user has approved this specific change after reviewing the adversarial review. Apply ONLY
this change — nothing else.

Change to make:
- File: {file}
- Location: {line range or function name}
- Current code: {snippet}
- Desired code: {snippet}
- Rationale: {short explanation from the finding + lead's assessment}

After applying:
- Verify project builds: `{compile_check} 2>&1 | head -30`
- Run lint: `{lint_check} 2>&1 | head -30`
- Do NOT add or modify anything else. If the requested change has knock-on effects (e.g.,
  changing a function signature requires updating call sites), STOP and report back to
  the lead — do not silently expand scope.
- Mark task #{id} as completed via TaskUpdate
```

### Adversarial Review Agent Template

**Claude Opus, `high` effort, detached worktree.** Give it the brief below and nothing
else — no plan, no specs, no prior findings.

```
You are reviewing a diff you did not write and know nothing about.

Base branch: {base_branch}
Read the diff yourself: git diff {base_branch}...HEAD

Report every defect you can defend, most severe first. For each one give the
file and line, what breaks, and the concrete inputs or state that make it break.
A finding you cannot state a failure case for is not a finding — drop it.

Do not suggest style changes. Do not restate what the code does.
If the diff is sound, say so and stop.
```

Persist each iteration's output for the audit trail. Phase 11 spawns a new agent with the
same brief against the updated diff, so each loop surfaces the remaining backlog without
inheriting the previous reviewer's position.

## Edge Cases

### Domain Review Finds Critical Issues

If a domain reviewer reports a critical issue (broken functionality, wrong API contract, missing implementation):

1. Do NOT proceed to commit/review on the broken work
2. Spawn a fix agent for the issue (lead never edits)
3. Re-run the domain reviewer on the fixed code
4. Then proceed to Phase 6 (commit)

### Implementation Agent Gets Stuck

If an implementation agent can't complete (missing dependency, unclear spec):

1. The agent should send a message to the team lead
2. Team lead resolves the blocker (asking the user if needed — never inventing scope)
3. Resume the agent with the resolution
4. Do NOT skip the domain review just because implementation was hard

### Circular Dependencies

If work unit A needs B and B needs A:

1. Break the cycle: identify the minimal interface contract
2. Implement the interface/types first as a shared task
3. Then both can proceed in parallel against the contract

### Single Work Unit

Even with just ONE implementation task, you still create:
- 1 implementation agent
- 1 domain reviewer (covering the one domain that WU touched)

The review overhead is minimal. The quality guarantee is not optional.

### Agent Edits Same File

If two implementation agents must edit the same file:

1. Make them sequential (blockedBy dependency)
2. Second agent reads the file AFTER first agent completes
3. Domain reviewer for that file's domain verifies both changes are intact and don't conflict

### Multi-Domain WU

If a single WU touches multiple domains (e.g., a feature that adds a schema in `packages/schemas` + SDK code in `packages/sdk` + a gate in `scripts/gates`):

1. The implementation agent for that WU does all the cross-domain work as one cohesive change
2. EACH affected domain's reviewer reviews the WU's changes within their domain
3. The schemas reviewer reads the schemas files; the sdk reviewer reads the sdk files; the scripts reviewer reads the gate — all from the same WU

### The Reviewer Finds Issues the Domain Reviewers Missed

This is expected — the reviewer reads the diff cold and may catch what a reviewer who knew the intent read past. Treat its findings as new input for the user gate. Do not reopen the domain review unless the user specifically requests it.

### Review Loop — User Doesn't Stop

There is no automatic cap. If iterations are accumulating, the lead should:
- Continue to summarise findings clearly
- Note when successive reviewers start repeating each other or producing nitpicks
- Surface that observation to the user — but do NOT decide to stop unilaterally
- The user is in the loop and signals when to stop

### The Reviewer Returns Nothing Usable

If the agent fails, times out, or returns an empty review:

1. Surface the exact failure to the user
2. Do NOT proceed to commit/push as if review had passed — an empty review is not a clean review
3. Ask the user how to handle: retry, skip this iteration, or abort

## Failure Escalation Protocol

This protocol governs what happens when a stage CANNOT complete — after within-stage retries are exhausted. It ensures deterministic teardown instead of improvised cleanup.

### Failure Classification

The agent does NOT choose severity — the table assigns it:

| Severity | Definition | Action |
|----------|-----------|--------|
| **Retryable** | Transient failure (network timeout, flaky command, temporary lock). | Retry up to budget. If budget exhausted → reclassify as Blocking. |
| **Blocking** | Stage cannot complete, but work so far is valid. | Preserve state, report to user, STOP. No further work on this stage. |
| **Catastrophic** | State is corrupted or approach is fundamentally wrong. | Preserve what's safe, report to user, STOP. No further work on ANY stage. |

### Retry Budget

Fixed limits per failure type. The agent does NOT negotiate these:

| Failure Type | Max Retries | On Exhaustion |
|-------------|-------------|---------------|
| Network timeout / transient API error | 3 | → Blocking |
| Command fails with same error after fix attempt | 0 (immediate) | → Blocking |
| Same test assertion fails after fix attempt | 0 (immediate) | → Blocking |
| Agent task fails (wrong output, stuck) | 1 | → Blocking |
| File conflict / merge conflict | 0 (immediate) | → Blocking |
| Missing branch / corrupted state | 0 (immediate) | → Catastrophic |

**Key rule:** If the same error recurs after a retry, it is NOT transient — reclassify as Blocking immediately. Do not use remaining retry budget on a recurring error.

### State Preservation Protocol

On any Blocking or Catastrophic failure, execute these steps IN ORDER:

1. **Commit WIP** — `git add {changed files} && git commit -m "WIP(escalation): {skill} - {stage} - {brief description}"`
2. **Do NOT** revert, delete branches, force-push, stash over existing stashes, or continue to the next stage
3. **Capture agent state** — record which agents completed, which failed, which were never started

### Escalation Report

When escalating, produce this EXACT structure (not free-form prose):

```
=== ESCALATION REPORT ===
Skill: {skill name}
Stage: {stage number and name}
Severity: {Retryable (budget exhausted) | Blocking | Catastrophic}

--- WHAT HAPPENED ---
{1-3 sentences: the specific failure and why it cannot be resolved}

--- WHAT WAS COMPLETED ---
{Bulleted list of stages/steps that finished successfully, with artifact references}

--- WHAT WAS NOT STARTED ---
{Bulleted list of stages/steps that were never begun}

--- STATE SNAPSHOT ---
Branch: {current branch name}
Last commit: {short hash and message}
Working tree: {clean | N files modified}
WIP committed: {yes — hash | no — reason}

--- ARTIFACTS PRESERVED ---
{Bulleted list: plan docs, WIP commits, test files, manual test sheets, agent reports, review outputs}

--- PIPELINE IMPACT ---
Plan still valid: {Yes | No — reason}
Can resume from here: {Yes — from {stage}, {checkpoint} | No — reason}
Downstream stages: Cancelled (not failed)

--- RECOMMENDED USER ACTIONS ---
1. {Specific action}
2. {Specific action}
=== END ESCALATION REPORT ===
```

### Teardown Rules

On Blocking or Catastrophic failure:
- **KEEP** all branches (feature branches, sync branches, WIP branches)
- **KEEP** all WIP commits (they are checkpoints)
- **KEEP** all agent teams and their reports until user reviews
- **KEEP** all plan documents, even if incomplete
- **KEEP** all test files, even if failing
- **KEEP** all stashes
- **KEEP** all review output files (`/tmp/adversarial-review-iteration-*.txt`)
- **NEVER** run `git reset`, `git clean`, `git checkout .`, `git branch -D`, or `git stash drop` during escalation

**"When in doubt, KEEP."**

### Cross-Stage Pipeline Rules

- A failed stage does NOT invalidate prior completed stages by default
- Each committed artifact is a checkpoint — the user can resume from the last checkpoint
- Downstream stages are marked "cancelled," NOT "failed" (they were never attempted)
- Orchestrator skills (ship, next) do NOT retry sub-skills — they wrap the sub-skill's escalation report and escalate to the user
- NEVER partially execute the next stage — either a stage starts fully or not at all

### Build-Specific Failure Handling

#### Key Failure Triggers
| Trigger | Classification |
|---------|---------------|
| Compile/build fails after 2 fix attempts on the same error | Blocking |
| Same test failure after 2 fix attempts | Blocking |
| Agent corrupts files outside its assigned scope (unrelated files modified) | Catastrophic |
| Domain review finds critical issue that invalidates the approach (not just the code) | Blocking |
| The adversarial reviewer fails twice in a row with the same error | Blocking |

#### State Preservation Specifics
- Per-WU checkpoints: each completed WU is committed separately before the next begins
- Per-iteration checkpoints: each review's output saved to `/tmp/adversarial-review-iteration-{i}.txt`
- Tag which WUs completed vs failed in the escalation report:
  | WU | Status | Commit |
  |----|--------|--------|
  | WU-1 | Completed (passed domain review) | `{hash}` |
  | WU-2 | Completed (passed domain review) | `{hash}` |
  | WU-3 | Failed (compile error after 2 fix attempts) | WIP `{hash}` |
  | WU-4 | Not started | — |

#### Cross-Stage Notes
- Completed WUs are safe — they passed the domain review and can be kept
- User resumes from the first failed WU, not from the beginning
- The plan is NOT invalidated by a build failure (unless the failure reveals the plan is wrong, which the report should note)

## Monitoring Protocol

While agents work, the team lead should:

1. **Poll TaskList** periodically to check progress
2. **Spawn next-wave agents** as soon as blockers clear
3. **Don't over-poll** — check every 15–30 seconds, not continuously
4. **Read agent messages** — they may report blockers or questions
5. **Verify file changes** between waves if concerned about conflicts

## Completion Criteria

The task is ONLY complete when:

1. All implementation tasks are completed
2. All domain review tasks are completed with no unresolved MUST FIX findings
3. All changes committed to the feature branch
4. The adversarial review has been run at least once and ALL user-approved amendments applied
5. User has explicitly confirmed acceptance
6. Feature branch pushed to remote
7. PR created (if user opted in) and `/verify` run (if user opted in)

## Anti-Patterns

| Anti-Pattern | Why It's Wrong | Correct Approach |
|-------------|----------------|------------------|
| Lead editing files directly | Bypasses agent discipline; the lead's role is coordination only | Spawn an agent (impl, fix, etc.) for every code change |
| Auto-applying review findings | User has the final say — auto-applied changes can be wrong | Lead summarises + proposes; user decides; fix agent applies |
| Imposing a cap on the review loop | The user is in the loop; they decide when to stop | No automatic cap — surface observations, let user decide |
| Skipping the user gate after review | Defeats the entire purpose of human-in-the-loop review | Always present findings + proposals and STOP |
| Skipping domain review "to save time" | Bugs caught later cost 10x more | Always run domain reviewers |
| Rubber-stamp domain reviews ("LGTM") | Defeats the purpose entirely | Reviewer must check every spec point + integration + conformity |
| Spawning all impl + review agents at once | Reviewers can't review unfinished work | Spawn in waves as dependencies clear |
| One reviewer per WU | Returns to the heavy old model | One reviewer per DOMAIN, regardless of WU count |
| Multiple reviewers in the same domain | Contradictory guidance, wasted effort | Always exactly ONE reviewer per domain touched |
| Hardcoding tech-specific commands | Breaks when used on different projects | Use `{compile_check}`, `{test_check}` variables |
| Shims, skipped tests, or copy-and-pastes | Never acceptable | When the plan can't be implemented as designed, refer to its architecture and design, and make the minimum change to implement the plan's objectives |
| Using standalone `Task` without `team_name` | Creates invisible sub-agents with no shared task list, no coordination, no message routing — defeats the entire team architecture | EVERY agent MUST use `Task` with `team_name` parameter. Zero exceptions. |
| Pushing or creating the PR without explicit user acceptance | The user is the final gate, not the reviewer | Wait for explicit acceptance before push + PR |
| Auto-running /verify | /verify is optional based on user direction | Offer it, run only if requested |
