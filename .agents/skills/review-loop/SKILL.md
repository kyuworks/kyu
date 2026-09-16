---
name: review-loop
description: Use when reviewing code or plans, especially across iterative re-review cycles. Standardizes fresh reviews and delta reviews with a locked findings register, paired recommendations, closure proofs, and "why new now" labels so follow-up passes stay focused instead of reopening the whole surface.
---

# Review Loop

Use this skill for plan reviews, code reviews, or mixed design and implementation reviews that are likely to go through more than one pass.

## Goals

- Find the highest-risk issues early.
- Pair every finding with a concrete recommendation.
- Make closure objective by defining proof needed to close.
- Keep re-reviews focused on deltas instead of reopening the entire artifact each round.

## Expectations

Do not promise exhaustive one-pass review coverage. A later pass can surface a real new issue when:
- a revision changes the design surface
- a fix exposes a previously latent dependency
- an earlier finding was only partially closed

When a new issue appears in a delta review, explain why it is new now instead of treating it as unexplained churn.

This skill structures a review when one is requested. It does not require a
pre-PR review or make `GO` a pull-request creation gate.

## Durable Register

Use a file-backed register by default, even when the user does not provide a
path. Store it at:

```text
.artifacts/reviews/<branch-slug>/findings-register.md
```

`.artifacts/` sits beside the shared `.git` directory, so every linked worktree
of one clone shares one register per branch slug rather than starting its own.
It is gitignored but stays in the workspace across chat compaction and normal
`/tmp` cleanup. Replace `/` in the branch name with `-`; when HEAD is detached,
use the stable slug `detached`. A user-provided path takes precedence. Create
the parent directory and copy `assets/findings-register.seed.md` when the
register does not exist.

When using the default path, run:

```bash
bash .agents/skills/review-loop/scripts/init-findings-register.sh
```

The script prints the resolved absolute path, so it opens from any working
directory including a linked worktree. It creates the register from the seed
when absent. On an existing register it refreshes
`Register path`, `Reviewed head SHA`, and `Reviewed scope state`, inserting any
of the four metadata keys that are missing. It never overwrites findings, and it
sets `Closeout state: active` only when that field is missing or empty, so a
recorded `delivered` state survives a refresh.

At the start of every pass, record the full `git rev-parse HEAD` value and
whether the reviewed scope includes worktree changes. At closeout, keep the
reviewed head SHA and delivery evidence in the register; do not rely on chat
memory for either.

## Review Modes

### 1. Fresh Review

Use on the first pass, or when the user explicitly asks for a broad new review.

Workflow:
1. Determine the artifact type: plan or code.
2. Resolve the durable findings-register path. Prefer a user-provided path;
   otherwise use the default above. If it does not exist, create it from
   `assets/findings-register.seed.md`.
3. Read the matching checklist:
   - plan: `references/plan-review-checklist.md`
   - code: `references/code-review-checklist.md`
4. Review the full requested scope.
5. Report findings first, ordered by severity.
6. For every finding, include:
   - finding
   - why it matters
   - recommendation
   - proof needed to close
   - watch-outs or likely side effects
7. Open or refresh the findings register with stable IDs like `F-01`, `F-02`.
8. Write the updated register to the resolved workspace path as well as
   returning it in the response.
9. End with `FINAL STATUS: GO` or `FINAL STATUS: NO-GO`.

### 2. Delta Review

Use when prior findings already exist and the artifact was revised.

Default rule: do not run a broad fresh review unless the user explicitly asks for one.

Workflow:
1. Load the active findings register.
   - If the register includes author-side implementation statuses such as `claimed fixed`, `partially addressed`, or `blocked`, treat them as claims to verify, not as closure.
   - Treat the resolved workspace register file as the primary source of truth.
2. Inspect only:
   - active findings
   - changed lines or sections intended to address them
   - direct dependency areas those changes can realistically affect
3. For each active finding, return exactly one status:
   - `fixed`
   - `still open`
   - `replaced by narrower issue`
4. Only add a new finding when one of these is true:
   - the recent change directly introduced it
   - the recent change invalidated a prior closure assumption
   - a direct dependency area now clearly contradicts the intended fix
5. Every new delta finding must include `why new now` with one of:
   - `introduced by recent change`
   - `previously latent, now exposed`
   - `missed in prior review`
6. Preserve original finding IDs where possible. Do not rename findings just because the wording changed.
7. Update the workspace register with the re-review result before responding.
8. End with an updated findings register and `FINAL STATUS: GO` or `FINAL STATUS: NO-GO`.

## Required Finding Shape

Recommendations are mandatory. Each finding should close the loop with:

- `ID`
- `Severity`
- `Finding`
- `Why it matters`
- `Recommendation`
- `Proof needed to close`
- `Watch-outs`

For delta reviews, also include:

- `Current status`
- `Why new now` for any truly new finding

## Review Rules

### Plans

- Anchor plan claims to real code whenever the plan depends on existing behavior, UI, API, or data shape.
- Treat rollout and transition rules as first-class review surfaces.
- Check that each PR or work unit is independently merge-safe if the plan claims it is.
- Separate blocking design contradictions from document cleanup drift.

### Code

- Findings come first. Keep summaries brief.
- Prioritize bugs, regressions, invalid assumptions, missing validation, data invariant breaks, and missing tests.
- Include file and line evidence when possible.
- Use cleanup comments only after blocking and medium-risk findings are settled.

## Anti-Loop Protocol

When a user is iterating between tools or reviewers:

1. Open or update the findings register first.
2. Re-review against the register, not against memory.
3. Use the template in `assets/findings-register-template.md` for handoffs.
4. If an implementation-side tool updated the register with author claims, verify those claims against the actual delta instead of trusting them.
5. If a section such as an audit trail is stale but non-blocking, classify it as `cleanup` instead of reopening the whole design.
6. If a new issue appears, label why it is new now before deciding whether it is blocking.

## Preferred File-Backed Flow

When the user wants lower-touch iteration, prefer a real workspace register file over pasted findings:

1. Fresh review writes or updates the register file.
2. Implementation updates the target artifact and amends the same register with author-side statuses.
3. Delta review reads the same register file, verifies the claims, and updates statuses again.

This keeps the review loop anchored to one file instead of conversational memory.

## Closeout

When the reviewed work is being delivered, update the register's delivery
closeout. Definition of done for that delivery is:

1. Record the scoped test, lint, typecheck, or gate commands that actually ran
   and their outcomes. Keep tests distinct from compile and lint checks.
2. Record the commit SHA after the commit hook completes.
3. Push and record the remote branch plus pushed SHA.
4. If a PR already exists, refresh its body so its summary, how-to-check
   evidence, and out-of-scope section match the pushed head. Record the PR URL
   and refreshed SHA.

Use `active`, `ready for delivery`, or `delivered` for closeout state. Set
`delivered` only after the applicable steps above are recorded. This closeout
applies only when the user asked to deliver the work; it does not introduce a
mandatory review before opening a PR.

## References

- `references/plan-review-checklist.md`
- `references/code-review-checklist.md`
- `assets/findings-register.seed.md`
- `assets/findings-register-template.md`
