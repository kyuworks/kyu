# Research report template

One agent, one report. Both explorers fill in this same shape so the comparison in
phase 1.4 is like-for-like.

Sections are a floor, not a ceiling. Add what the question needs; never drop one of
these five. If a section has nothing in it, write why — an empty section is a claim.

---

```markdown
# Research: {question}

**Angle:** {ground | frame}
**Date:** {YYYY-MM-DD}
**Repository state:** {branch} @ {short sha}

## 1. Problem statement

Restate the problem in your own words, in plain language. What are we trying to
achieve, and what does success look like? If your restatement differs from the brief
you were given, say so explicitly — a divergence here is the most valuable thing you
can report.

## 2. Research methodology

What you actually did, in order. Which directories you read, which searches you ran,
which external sources you consulted, what you deliberately did not look at and why.

A reader must be able to repeat your work from this section alone.

## 3. Findings and evidence

| # | Finding | Evidence | Confidence | Implication |
|---|---|---|---|---|
| 1 | One sentence, stated as a fact | `path/to/file.ts:42`, a command and its output, or a cited URL | High / Medium / Low | What follows for the decision |

Rules for this table:

- **Every row cites something.** A file and line, a command and its output, or a URL.
  A finding with no evidence column is an opinion and belongs in section 4.
- **Confidence is about the evidence, not the conclusion.** "I read the code and it
  says X" is High. "This is the usual pattern in projects like this" is Low.
- **Cite what exists.** Never write a plausible-looking path you did not open.

## 4. Options considered

For an architectural question, at least two. For each:

| Option | How it works | Cost | Risk | Reversibility |
|---|---|---|---|---|

Reversibility matters more than it looks. An option you can undo in a day is worth
picking under uncertainty over one you cannot.

## 5. Conclusion

Your recommendation, in one paragraph of plain language, and the single strongest
argument against it. If you cannot name an argument against, you have not finished.

## 6. Open questions for Matt

Numbered. Each one must be answerable without Matt reading the codebase.

| # | Question | Why it blocks | What each answer would change |
|---|---|---|---|
| 1 | | | |

Do not pad this section. Three real questions beat ten hedges. If you can answer a
question yourself by reading the repository, do that instead of asking.
```
