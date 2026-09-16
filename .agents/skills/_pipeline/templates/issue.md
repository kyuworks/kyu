# GitHub issue templates

Two shapes. The **feature issue** is the contract for the whole feature; a **sub-issue** is
the contract for one PR. Both come from the engineering plan plus the testing sub-plan,
**minus the execution steps**.

Create both with `gh issue create` (the GitHub MCP may not be available). Native
sub-issues cannot be attached through `gh`, so a sub-issue is linked by convention: its
body starts with a `Part of #N` line naming the feature issue, and the feature issue body
lists every sub-issue. Both directions, always.

```bash
gh issue create --title "{Feature name}" --body-file planning-gitignored/plans/{slug}-issue.md
gh issue create --title "{Feature name}: {PR slice}" --body-file planning-gitignored/plans/{slug}-sub-1.md
```

Write them in ISO 24495-1 plain language — invoke the `iso-24495` skill for the wording.

---

## The feature issue

```markdown
## Problem

What a consumer of the bus cannot do today, and what that costs them. Plain language.
No file paths, no function names — this section is for someone who has never opened
the repository.

## What NOT to do

The non-goals from the engineering plan, plus the shortcuts a future implementer would
reach for and regret. Say why for each one.

- **Do not** {shortcut} — {what breaks if you do}

## Solution

The design from the engineering plan: files, message contract, data flow, outbox and
relay behaviour. This is where paths and symbols belong.

## Flows covered

The engineering plan's inventory, as a checklist. A reviewer uses this to see what was
considered, including the flows deliberately left out.

- [ ] {flow}

## Acceptance criteria

Every one a checkable assertion with a subject and an observable outcome.

**Unit**
- [ ] {assertion}

**Integration (Hatchet stack)**
- [ ] {assertion}

**Not automated**
- {flow} — {why} — {how it is covered instead}

## Sub-issues

- [ ] #{N} — {PR slice}

## Proof standard

Each criterion above must be shown failing before the implementation exists (RED₁),
passing after it (GREEN), and failing again with the implementation removed (RED₂).
Pasted command output is the evidence. A green test with no recorded red does not count.
```

---

## A sub-issue

Short. It carries only what is its own — the reader follows the link for context.

```markdown
Part of #{feature issue}.

## Scope

The work units and files this PR touches. Two or three lines. If this section needs more
than that, the PR is too big and the plan's decomposition was wrong.

## Acceptance criteria

The slice of the feature issue's criteria this PR must satisfy, **copied verbatim** so they stay
checkable here rather than by cross-reference.

- [ ] {assertion}

## Depends on

- #{N} — must merge first, because {reason}

Or "Nothing — this can merge on its own."

## Proof

| Criterion | Test | Level |
|---|---|---|
```

**Do not** restate the problem, the design, or the non-goals. They are on the feature issue,
and a second copy is a second thing to keep in sync.

---

## After creating them

Update the feature issue body with the list of sub-issues (`gh issue edit N --body-file`),
so traceability runs both ways: the sub-issue says `Part of #N`, the feature issue lists
its children.

Record both numbers. The **sub-issue** number goes in that PR's branch name, its commits
(`#NNN`), and `Closes #NNN` in the PR body. The **feature issue** number appears in the
phase-7 summary.

**The feature issue does not close on its own** — without native sub-issues GitHub does not
know the children belong to it. When the last sub-issue closes, tell Matt on the feature
issue and let Matt close it. Never close either level from an agent — a merge closes a
sub-issue, and only Matt merges.
