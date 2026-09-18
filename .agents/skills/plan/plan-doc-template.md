# Plan Document Template

This file holds TWO templates: a **Compact variant** for Small complexity (1 WU, ≤3 files, ≤50 LOC, single package), and a **Full variant** for Medium/Large. Pick using the tier from [`SKILL.md`](SKILL.md) § 1a.

The `## PR Plan` section is mandatory in BOTH variants — see [`pr-decomposition.md`](pr-decomposition.md). Missing required sections are audit failures.

**Anchor every file reference semantically, in both variants** — a path plus the symbol, heading, or a short quoted snippet, never `path:line`. This document is written to `planning-gitignored/plans/` and read by later phases after the code has moved, so a line number in it is a stored claim that goes stale. Where the target genuinely has no name — a config block, a statement inside an outbox migration, a compose service — quote enough of it to grep for.

---

## Compact variant (Small complexity)

Use when ALL of: complexity = Small, ≤3 files, ≤50 LOC estimated, single package, 1 WU. Target length 60–120 lines. Same audit cycle as Full — load-bearing audit findings still go in the doc, but inline (Risks bullet or Approach narrative), not in a per-finding Audit Trail table.

```markdown
# Plan: {Feature Name}

**Issue:** #{number} (if applicable)
**Date:** {YYYY-MM-DD}
**Complexity:** small
**Confidence:** {high / medium / low} (from integration audit)

## Summary

{2-3 sentences: what is being built/fixed and why. Plain prose.}

## Current State

{1-2 paragraphs grounded in file references. Quote the buggy/relevant block. Name the canonical signal or pattern that should be used. Cite specific files by path and symbol.}

## Approach

**Files to change:**
- `path/to/file.ts` → `symbolName` — {what changes, one sentence}
- `path/to/test.ts` — {tests added}

{1-2 paragraphs on the approach. Justify the choice — especially if an audit caught an alternative that would have been wrong (cite it inline, e.g. "Initial draft gated on X; integration audit caught that this would regress Y."). Note any deferred follow-ups in this paragraph.}

## PR Plan

**Strategy:** single PR, ~{LOC} / {N} files. Branches off main. **Proves:** {one sentence — what a reviewer can verify}. **Proof artifact:** {description}.

## Work Unit

- **Files:** {as above}
- **Acceptance criteria:**
  1. {specific, testable}
  2. {specific, testable}
  3. ...
- **Test requirements:** TDD red→green; {N} new tests covering {what matrix}; existing tests stay green.

## Risks

- {Risk → likelihood → mitigation, one bullet each}
- {Include "design-smell follow-up" or "deferred refactor" risks here as bullets, not a separate section}

## Audit Trail

**{Auditor confidence}** at commit time. Critical findings addressed: {one-sentence summary, or "none"}. Notable audit-caught issues already woven into Approach above.
```

**Compact variant rules:**
- No tables for Risks, Test Plan, Indirect Impacts, or per-finding Audit Trail. Use inline narrative.
- Single Work Unit folded into the doc — no separate "Files to Change" + "Acceptance criteria" + "Audit focus" + "Integration concerns" sub-bullets unless they add information beyond what's in Approach.
- "Impact Analysis" not its own section — folded into Approach if non-trivial.
- Total target: 60–120 lines. If you're hitting 150+, either the change is bigger than Small (switch to Full) or you're padding (trim).

---

## Full variant (Medium/Large complexity)

Use when complexity is Medium or Large, OR when any compact trigger condition fails (>3 files, >50 LOC, multiple packages, >1 WU). Missing sections in this variant are audit failures.

```markdown
# Plan: {Feature Name}

**Issue:** #{number} (if applicable)
**Date:** {YYYY-MM-DD}
**Complexity:** {small / medium / large}
**Confidence:** {high / medium / low} (from integration audit)

## Summary

{2-3 sentences: what is being built/fixed and why}

## Requirements

{Numbered list of requirements extracted from the issue/spec/prompt}

1. {Requirement}
2. {Requirement}

## Current State

{What exists today in the codebase. Specific file references.}

### Relevant Files
| File | Role | Will Change? |
|------|------|-------------|
| `src/...` | {what it does} | Yes / No (read-only dependency) |

## Approach

### {Section 1: e.g., "`packages/schemas` changes"}

**What:** {Brief description}

**Files to Change:**
- `src/...` → `symbolName` — {what changes and why}
- `src/...` → `symbolName` — {what changes and why}

**Details:**
{Specific implementation approach, grounded in codebase references}

### {Section 2: e.g., "`packages/sdk` changes"}

{Same structure as above}

## PR Plan

**Total estimated change:** ~{LOC} across {N} files → split into {M} PRs.
**Strategy:** {stacked | sequential}

### PR-1: {scope in 3-6 words}
- **Work Units:** WU-1, WU-2
- **Estimated diff:** ~{LOC} / {files}
- **Branches off:** main
- **Depends on:** none
- **Proves:** {one sentence — what a reviewer can verify in isolation}
- **Proof artifact:** {pasted test run / assertions table description}

### PR-2: {scope}
- **Work Units:** WU-3
- **Estimated diff:** ~{LOC} / {files}
- **Branches off:** main (independent) | PR-{k}'s branch (chained — real dependency only) | main after PR-{k} merges (sequential)
- **Depends on:** none (if independent) | PR-{k} (if chained or sequential)
- **Proves:** {...}
- **Proof artifact:** {...}

*(Include one entry per PR. A plan with only one PR may use a single entry and `Strategy: single PR`.)*

## Work Units

Each work unit maps 1:1 to one implementation agent in **build**. Acceptance criteria become the audit contract — auditors verify these point-by-point. "Depends on" maps directly to blockedBy dependencies in the task graph. The "PR" field maps this WU to one of the PRs in the PR Plan above.

### WU-1: {Short title}
- **PR:** PR-1
- **Domain:** {schemas / sdk / infra / scripts / docs}
- **Agent scope:** {what this agent owns — be specific about which files and responsibilities}
- **Files to create/modify:**
  - `src/...` → `symbolName` — {what changes and why}
  - `src/...` → `symbolName` — {what changes and why}
- **Depends on:** {WU-N or "none"}
- **Acceptance criteria:**
  1. {Specific, testable criterion}
  2. {Specific, testable criterion}
  3. {Specific, testable criterion}
- **Audit focus:** {What the correctness auditor should pay special attention to}
- **Integration concerns:** {What the integration auditor should verify — call sites, imports, side effects}
- **Test requirements:** {What tests must be written or updated}

### WU-2: {Short title}
{Same structure as above}

**Rules:**
- Every file change in the Approach section MUST appear in exactly one WU
- If a file appears in multiple WUs, the WUs MUST have a dependency (second WU depends on first)
- Every WU MUST be assigned to exactly one PR via the `**PR:**` field
- A WU cannot span two PRs — split the WU if needed
- Acceptance criteria MUST be specific enough to verify programmatically (not "works correctly" — instead "`publish()` inside a rolled-back transaction leaves no `qtaxis_outbox` row")
- Every WU MUST have at least 2 acceptance criteria
- "Audit focus" and "Integration concerns" give auditors targeted guidance beyond the generic dimensions

## Impact Analysis

### Direct Impacts
| File/System | Impact | Severity | Mitigation |
|------------|--------|----------|------------|
| `src/...` | {what changes} | {low/medium/high} | {how to handle} |

### Indirect Impacts (Ripple Effects)
| File/System | Why Affected | Action Required |
|------------|-------------|----------------|
| `src/...` | {imports changed module} | {update import / update tests / no action} |

### Breaking Changes
{List any breaking changes, or "None" if no breaking changes}

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| {risk} | {low/medium/high} | {low/medium/high} | {strategy} |

## Test Plan

### Existing Tests Affected
| Test File | Why Affected | Action |
|----------|-------------|--------|
| `src/...` | {reason} | {update / delete / no change} |

### New Tests Required
| Test | What It Proves | PR |
|------|---------------|-----|
| {test description} | {what behavior it verifies — unit, or integration against the Hatchet stack} | PR-1 |

### Integration Proof Plan
{One proof set per PR. There is no UI: proof is a command and its pasted output, run against the local Hatchet stack (`pnpm hatchet:up`) where the level is integration:}

**PR-1 proof:**
1. Before state: {what to run and what its output shows before the change — the RED₁ output}
2. Action: {the command that exercises the change, e.g. `pnpm --filter @qtaxis/sdk test:integration`}
3. After state: {the pasted output that shows the assertion passing}

**PR-2 proof:**
{...}

## Audit Trail

### Findings Addressed
| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | {finding from audit} | {critical/major/minor} | {how addressed in plan} |

### Auditor Confidence
| Auditor | Confidence | Notes |
|---------|-----------|-------|
| {agent name} | {high/medium/low} | {brief note} |
```
