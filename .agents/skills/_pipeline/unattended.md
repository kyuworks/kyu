# Unattended mode

A cloud routine runs the pipeline with nobody to answer its gates. This page says what
each gate becomes. Every phase skill points here rather than restating it.

## How a run knows

`detect-stage.sh` prints `UNATTENDED=yes` when `CLAUDE_CODE_REMOTE=true` — the same
variable `scripts/hooks/agent-guard.sh:40` reads. Read that line; do not read the
environment yourself, so there is one detector and it cannot disagree with the guard.

There is no way to turn unattended **off** in the cloud. The guard denies the dangerous
things regardless of what a skill believes.

## What each gate becomes

A gate was a question. Unattended, it becomes a written record of the answer, then the
run continues — except the one that hands work to Matt, which stops.

| Gate | Attended | Unattended |
|---|---|---|
| Tier (`/ship` step 1) | show tier, reason, agent count; wait | decide by the rubric at `ship/SKILL.md` step 1; between two tiers take the lower plus one safeguard; ambiguous → STANDARD; **record**, continue |
| Research artifact (`/research`) | Matt answers the decision flow | answer each item from the research, mark any the research could not settle; **record**, continue |
| Plan (`/plan` § 5) | show behaviour, non-goals, riskiest flows, PR shape; wait | **record** the same four things plus the options rejected, continue |
| Single-PR collapse (`/prereq` 3.3d) | offer to collapse; wait | one issue; **record** |
| PR (`/wrap` → `/open-pr`) | ask; Matt decides | open the draft with `--base main`, post the report as a comment on the feature issue, **stop** |

"Record" means a decision comment, below, posted before the run moves on.

## The decision record

**Template:** [`templates/decision-comment.md`](templates/decision-comment.md).

Posted as a comment on the feature issue at the moment of decision. That issue does not
exist until `/prereq` creates it, so the tier, research and plan decisions are held in
the run and posted together, in order, the moment it does — never dropped, never posted
elsewhere. The PR body carries one line per decision with a link to the comment.
`planning-gitignored/` keeps the working documents as always, but a cloud VM's copy dies
with it, so it is never the record.

The comment names every option, the one chosen, one line per option rejected, the
reasoning, and that Matt can overturn it by replying. It is the same information the
attended gate would have put in front of Matt.

## When the rubric cannot decide

Open a `decision:` issue — title starts `decision:`, body is the question, the options,
the owner (Matt), when it is needed by, and a link to the feature issue. Then record the
block where the next run will read it: add a `Blocked by #N` line to the feature issue's
body with `gh issue edit --body` (the guard denies state changes, not body edits), and
comment why. Then stop this feature. `/next` reads the feature issue's thread before it
acts, so the work is not picked up again until Matt closes the decision issue.

Closing the decision issue is the decision; its closing comment holds the outcome.

## What never changes

The guard, not this page, enforces these. Listed so no skill argues with a denial:

- draft pull requests only, with `--base main` written out — the guard denies a PR that
  is not a draft, and a PR whose base is left implicit
- never `gh pr ready`, never merge, never `gh pr edit --base`
- never close, reopen, or otherwise change an issue's state — opening one and commenting are allowed
- never a writing GitHub REST call (`gh api -X POST`, `curl`)
- never push to `main`; never `--no-verify`; never `git stash`
- never edit the guard, its screen, or the settings file that routes them
