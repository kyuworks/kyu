---
name: open-pr
description: "Commit changes, push branch, and create a PR targeting main. Use when implementation is complete and ready for review."
---

# Open PR

Commit staged work, push the branch, and open a pull request against `main`.

## When to Use

- After implementation is complete and the commit hook is green
- Any time a branch is ready for a PR

## Inputs

- `{branch}` — current feature branch name (`feat/{slug}`, `fix/{slug}`, or `chore/{slug}`)
- `{issue}` — issue number (optional, may not exist)
- `{description}` — brief summary of what was done

## Hard Rules

1. **NEVER `git add -A` or `git add .`** — always add specific files by name. Sensitive files (.env, credentials) and large binaries must never be committed.
2. **NEVER commit build output or dependencies** — no `node_modules/`, no `dist/`. **DO commit SQL migration files** (`packages/sdk/migrations/*.sql`) when the outbox schema shipped to consumers changes — CI requires them, and `scripts/gates/check-migration-immutability.sh` rejects edits to a migration that already exists. Add a new file; never change an old one.
3. **Amend only an unpushed HEAD you authored.** If `@{u}` exists and `git merge-base --is-ancestor HEAD @{u}` is true, HEAD is already on the remote — make a new commit. Otherwise `git commit --amend` is allowed. Never amend someone else's commit. Never force-push.
4. **NEVER force-push** — always regular push.
5. **PR targets `main`.** `main` is the only long-lived branch; there is no `develop`. Nothing deploys from a merge yet.
6. **Never merge.** Matt merges. Reviewers are the product and architecture reviewers.

## Step 1: Review What Changed

Before committing, understand the full scope:

```bash
# See all changes (staged + unstaged + untracked)
git status
git diff --stat
```

Categorize files into:
- **Implementation files** — source code and colocated tests under `packages/*/src` (COMMIT)
- **ADRs** — `docs/architecture/adr/*.md` (COMMIT)
- **SQL migrations** — `packages/sdk/migrations/*.sql` (COMMIT when the outbox schema changed; new file only)
- **Gates and scripts** — `scripts/gates/*.sh` with their `*.test.sh` (COMMIT)
- **Planning documents** — `planning-gitignored/` (gitignored; never committed)
- **Review registers and logs** — `.artifacts/` (gitignored; never committed)
- **Build output** — `dist/`, `node_modules/` (DO NOT COMMIT)
- **Sensitive files** — `.env`, credentials, secrets (DO NOT COMMIT)

## Step 2: Do Not Pre-Run the Suite

The commit is the verification checkpoint. The pre-commit hook runs
`pnpm check:changed --staged`, which selects lint, typecheck, the affected tests,
and the owning gates for exactly the files you staged.

So there is nothing to run here. Stage, then commit, and let the hook
verify. If it fails it prints `FAILED`, the first error, and a log path under
`.artifacts/check/` — fix that and commit again (or amend if HEAD is still unpushed).

Do not run a full suite before committing. `pnpm check` is the exhaustive backstop,
and hosted CI runs it on the PR. Never pass `--no-verify`.

## Step 3: Stage Files

Add files by name or by directory. Group logically:

```bash
# Implementation
git add packages/sdk/src/outbox/relay.ts packages/schemas/src/envelope.ts

# Tests
git add packages/sdk/src/outbox/relay.test.ts packages/sdk/src/outbox/relay.integration.test.ts

# Migration (if the outbox schema changed — new file only)
git add packages/sdk/migrations/0002_add_partition_key.sql

# ADR (if exists)
git add docs/architecture/adr/0003-my-decision.md
```

After staging, verify nothing unwanted slipped in:

```bash
git diff --cached --name-only
```

## Step 4: Commit

Write a commit message that describes the **why**, not the what. Use conventional commit format.

```bash
git commit -m "$(cat <<'EOF'
feat: {short description of what was built/fixed}

{1-3 sentences explaining the change and its purpose}

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

**Commit message rules:**
- Prefix: `feat:` (new feature), `fix:` (bug fix), `refactor:`, `test:`, `docs:`, `chore:`
- First line under 72 characters
- If there's an issue: add `closes #{issue}` or `fixes #{issue}` in the body
- Always include the Co-Authored-By line

## Step 5: Push

```bash
git push -u origin {branch}
```

If push fails:
- **Auth error** — ask user to check credentials
- **Remote rejected** — check if branch protection rules apply
- **Diverged** — do NOT force-push. Ask user how to proceed.

## Step 6: Create or refresh the PR

Write the title and body in plain language (simple words, no assumed context,
no metaphors). First sentence is the change. Do not publish until that holds.

First, look for a PR with all three exact attributes: state `open`, head branch
`{branch}`, and base branch `main`:

```bash
gh pr list --state open --head "{branch}" --base main
```

Do not reuse a closed PR, a PR from another head branch, or a PR targeting
another base.

- If none exists, create it with the body below.
- If exactly one exists, refresh that PR's title and complete body with
  `gh pr edit`, using the same template. The body must describe the pushed head,
  not the state from the previous iteration. Do not create a duplicate PR.
- If more than one exact match exists, stop and report the duplicate open PRs.
  Do not select or update one arbitrarily.

**Unattended** (`UNATTENDED=yes` from `detect-stage.sh`): use `--draft --base main`.
The guard (`scripts/hooks/agent-guard.sh`) denies a non-draft create and a create
without an explicit `--base` in the cloud, so without both flags every unattended run
ends in a denial at its last step. Matt marks it ready.

**Under a feature issue**: when the PR closes a sub-issue, keep the
`Part of #{feature issue}` line so the feature issue shows which of its sub-issues
already have a pull request.

```bash
gh pr create --base main --title "{title}" --body "$(cat <<'EOF'
## Summary
{First sentence: what landed and why a reviewer should care.}

- {One change. One idea.}
- {One change. One idea.}

## How to check
- {Command the reviewer can run, e.g. `pnpm --filter @kyuworks/sdk test`.}
- {Behavior change only: the test that failed without the production change. Omit for docs, lint, generated-only.}

## Agent ship loop

Behavior changed: yes | no
Red proof: `{test that failed before the change}` | N/A

- [x] Plan (call stacks if this adds or edits a publish path, relay step, or handler; otherwise N/A)
- [x] Red must-hold (or N/A: docs / lint / rename / generated-only)
- [x] Smallest diff
- [x] `pnpm check:changed` (commit hook counts)
- [x] Separate review (not the author)
- [x] Hosted CI — do not claim done from a local green

## Out of scope
- {What this PR does not do. Omit the heading if nothing.}

---
Closes #{issue}
Part of #{feature issue} — only when this PR closes a sub-issue; otherwise omit
EOF
)"
```

Agents must keep `## Agent ship loop` and check every item. Run
`bash scripts/gates/check-agent-ship-loop.sh --body <pr-body> --agent`
(add `--behavior-changed` when behavior changed) before create or
refresh. A failing checker means the PR is not Ready. Humans delete that
heading on a tiny PR. See `AGENTS.md` § Agent ship loop.

The size gate (`scripts/gates/check-pr-size.sh`) fails a PR over 400 net production
lines. Split the PR or ask Matt to add the `oversized-justified` label; do not add it
yourself.

**PR title rules:**
- Under 70 characters
- Imperative mood ("Add feature" not "Added feature")
- No issue number in the title (goes in the body)
- Outcome, not journey ("Run SDK tests under Node 24", not "Work toward moving tests")

**If no issue exists:**
- Remove the `Closes #` line
- Note in the summary that there's no linked issue

**If PR creation or refresh fails:**
- Verify branch is pushed: `git log origin/{branch} --oneline -1`
- Verify `main` is the default branch: `gh repo view --json defaultBranchRef`
- Repeat the exact existing-PR lookup:
  `gh pr list --state open --head "{branch}" --base main`

## Step 6a: Record delivery closeout

This step applies only when a review loop ran and left a findings register.
Skip it when no review was requested. It is not a pre-PR review gate.

If a register exists, update its delivery closeout after the commit, push, and
PR create or refresh. The default register is
`.artifacts/reviews/<branch-slug>/findings-register.md`. Do not derive that path
yourself. Run the initializer, which prints the resolved path and leaves
existing findings intact:

```bash
bash .agents/skills/review-loop/scripts/init-findings-register.sh
```

A path the user gave takes precedence. `.agents/skills/review-loop/SKILL.md`
owns path resolution (see its Durable Register section) and the closeout fields
(see its Closeout section).

Record:

- scoped commands and their actual outcomes
- local commit SHA
- remote branch and pushed SHA
- PR URL and the SHA represented by the refreshed body
- `Closeout state: delivered`

This records delivery evidence. It does not require a pre-PR review when no
review loop was requested.

## Step 7: Report and stop

Output the PR URL and a one-line summary, then **stop**. Do not wait for
GitHub Actions, `gh pr checks`, or `gh run watch`. CI is hosted.

```
PR created: {url}
{branch} → main | {N} files changed | {title}
```
