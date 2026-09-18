---
name: research
description: Phase 1 of the feature pipeline. Refines a problem statement by grilling Matt, runs two agents independently over the same question from different angles, revises both from Matt's answers, has a second pair reconcile the two reports, and publishes a plain-language decision artifact. Use for architectural decisions, unfamiliar subsystems, "should we use X or Y", or any question where getting the shape wrong is expensive. Use when Matt says "/research", "look into", "investigate", "what are our options for". Do NOT use for a change whose shape is already obvious — go straight to /plan.
---

# Research — phase 1

Two agents research the same question from different angles without seeing each other's
work. Where they agree independently, that is the strongest signal this phase produces.
Where they disagree, that is exactly what Matt needs to decide, and nothing else is.

**Both are Claude, so their blind spots correlate.** Agreement here is weaker evidence
than agreement between two vendors would be, and the 1.5 artifact says so. What the pair
still buys is separate context and two genuinely different lines of attack — enough to
catch a misread file or an unexamined assumption, not enough to catch something the model
is wrong about in the same way twice.

Everything lands in `planning-gitignored/research/{slug}/`.

```
1.1  PROBLEM      draft the statement, grill Matt until it is sharp    → problem-statement.md
1.2  EXPLORE      two agents, same question, different angles, no contact → report-ground.md, report-frame.md
1.3  ANSWER       Matt's answers to the open questions from both reports → answers.md
1.3b REVISE       both reports revised from Matt's answers               → both reports, in place
1.4  RECONCILE    two more agents, each merges the two reports           → merge-a.md, merge-b.md
1.5  DECIDE       one plain-language artifact, published                → Artifact
```

**Do not skip 1.1.** A vague brief produces two vague reports and there is nothing to
reconcile. The grilling is the cheapest step and it determines the value of the rest.

---

## 1.1 — Problem statement

Draft it first, then attack it. Never open with an empty questionnaire.

Write `planning-gitignored/research/{slug}/problem-statement.md`:

```markdown
# Research question: {one sentence}

## What we are trying to achieve
## Why now — what is the cost of leaving it
## What Matt already knows             ← Matt's leads, context, prior attempts
## Constraints                          ← what is fixed and cannot be traded
## Out of scope
## What a good answer looks like        ← how we will know the research succeeded
```

Then **invoke the `grilling` skill** on the draft. It exists for exactly this. If that
skill is not installed, run the attack yourself against the list below. Push until each
of these is true:

- The question has one sentence, and that sentence names a decision, not a topic
- Success is stated as something observable, not "better" or "cleaner"
- Every constraint is real. "The outbox lives in the producer's Postgres" is a
  constraint; "it should be fast" is not
- The out-of-scope list is not empty

Write the statement to disk before spawning anything. Both agents read that file — it
is the only thing they share, so it has to carry the whole brief.

**Nothing in `planning-gitignored/` is committed.** Ensure the ignore rule exists first:

```bash
grep -q '^planning-gitignored/' .gitignore || printf '\n# Local planning docs — not part of the repo\nplanning-gitignored/\n' >> .gitignore
```

---

## 1.2 — Two independent explorations

Both get the same question and the same report template. Neither is told what the other
found, or that another agent exists. Contaminating one with the other's framing destroys
the whole point of running two.

Both run via the `Agent` tool with `subagent_type: "Explore"`, at the model and effort
the [model table](.agents/skills/_pipeline/README.md) gives the research explorer row.
Spawn them in one message so they run concurrently.

**Where they differ is the attack angle**, and this is the only thing keeping the pair
from producing one report twice. Give each the shared brief below plus exactly one of:

| Agent | Angle | Starts from |
|---|---|---|
| **ground** → `report-ground.md` | Bottom-up. What the code actually does today | The repository. Grep, read call sites, run things. No outside sources until the repo is exhausted |
| **frame** → `report-frame.md` | Top-down. What the constraints admit | The problem statement's constraints, the design document (`docs/design/qtaxis-requirements-and-design.md`) and Hatchet's documented behaviour. Reads the repo only to check a claim |

Neither angle is the right one. The pair exists so a wrong answer has to survive both.

**The shared brief for both**, identical apart from the angle above and the output path:

> Read `planning-gitignored/research/{slug}/problem-statement.md`. Research this question against
> this repository and produce a report following the template at
> `.agents/skills/_pipeline/templates/research-report.md` exactly, writing it to
> `planning-gitignored/research/{slug}/{report-name}.md`.
>
> Ground every finding in evidence — a file and line you actually opened, a command
> and its output, or a cited URL. Never write a path you did not read. A finding you
> cannot evidence belongs in the conclusion as an opinion, clearly labelled.
>
> End with open questions for the person who commissioned this. Ask only what you
> genuinely cannot resolve by reading the repository yourself.

**Read-only.** Research does not write code. The explorers write their own report and nothing else.

---

## 1.3 — Matt's answers

Collect the open questions from both reports. **Deduplicate before asking** — the two
agents will overlap, and asking the same thing twice reads as not having read them.

Present them as one numbered list, grouped by what they block. For each, say what changes
depending on the answer. A question whose answers all lead to the same build is not worth
Matt's time — drop it.

Ask them in one message. Five round trips to settle five small things costs five full
context replays, and Matt is reading on screen.

### Why the answers come after 1.2 and not during it

Phase 1.2 works **because** the two agents cannot see each other. Answering an open
question mid-flight would leak one agent's framing into the other through Matt, and the 1.4
reconciliation would be partly an echo rather than a second opinion.

Both reports already exist by the time Matt gets here. So the answers cost nothing:
independence is banked, and Matt is arguing with two finished reports rather than steering
them as they are written.

Write the answers to `planning-gitignored/research/{slug}/answers.md`, attributed to the
question each one settles. Both revisions read that one file.

### 1.3b — Revision

Send each report back to a fresh agent with `answers.md` and the instruction to revise in
place. One agent per report, each seeing only its own.

Do not cross the reports over. Independence holds until 1.4.

## 1.4 — Two reconciliations

Now both reports go to two fresh agents. Each produces its own merge, writing to
`merge-a.md` and `merge-b.md`.

Neither reconciler wrote either report, and neither sees the other's merge. Spawn both in
one message. Same brief:

> Here are two independent research reports on the same question:
> `report-ground.md` and `report-frame.md`. Produce a merge that states:
>
> 1. **Agreed** — findings both reports reach, with the evidence each cited
> 2. **Contradictory** — where they reach opposite conclusions. For each, which
>    evidence is stronger and why. If you cannot tell, say so — do not split the
>    difference to look decisive
> 3. **Unique** — findings only one report has, and whether the other missed it or
>    ruled it out
> 4. **Your resolution** — the recommendation you would make from both, and the
>    strongest argument against it
>
> Do not defer to either report because of the angle it took. Weigh the evidence.

Two merges, deliberately. If the two reconciliations also disagree, that disagreement
is real and structural, and Matt must see it rather than have it averaged away.

---

## 1.5 — The decision artifact

**Load the `artifact-design` skill first.** Then build the page to
`.agents/skills/_pipeline/templates/research-reconciliation.md`.

The whole point: Matt has not read the four documents and should not have to. Plain
language, tables for every comparison, and a decision flow where each option maps to a
concrete build consequence.

**Say what the agreement is worth.** Where both reports and both merges agree, state that
four Claude runs agreed and that this is one model's view reached four ways, not four
independent confirmations. Matt decides how much weight that carries; hiding it inside
a confident recommendation makes the decision for Matt.

Publish with the `Artifact` tool. Send the link.

**Unattended** (`UNATTENDED=yes` from `.agents/skills/next/detect-stage.sh`): answer each
item of the decision flow from the research, mark the ones it could not settle, post that
as a decision comment on the feature issue, and continue —
[`_pipeline/unattended.md`](.agents/skills/_pipeline/unattended.md).

Otherwise stop. Do not roll into planning — Matt's answers to the decision flow are the
input to phase 2, and you do not have them yet.

---

## Cost control

| Step | Agents | Why that many |
|---|---|---|
| 1.2 | 2, different angles | Independence is the product. One is not research, it is an opinion |
| 1.3 | 2 revisions | Each reads `answers.md` and its own report. Matt's answers add no agents |
| 1.4 | 2 merges | A single merge inherits whichever report it read first |
| 1.5 | 0 | The lead writes it from four files already on disk |

Six agent runs, no more, unless Matt asks. Everything else in this phase is file reading
and Matt's judgement. **The lead never reads the repository itself in this phase** — that
is what the explorers are for, and duplicating their work is the main way this phase
gets expensive.

## Skipping this phase

Say so and route to `/plan` when the question is not architectural: a bug with a known
cause, a change to one file, a copy edit, a version bump. Research on those is theatre.
