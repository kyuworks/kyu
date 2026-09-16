# Reconciliation artifact — specification

Phase 1.5. Published with the Artifact tool, not left as a file.

Two agents researched the same question and two more merged their reports. Matt now
has to decide. This artifact exists to make that decision take five minutes, not an
afternoon of reading four documents.

## Audience rule

Matt has not read the reports and should not have to. Every term is defined in the same
sentence it first appears in. No abstract nouns standing in for decisions — not "the
ordering semantics are unresolved" but "nobody has decided whether two updates to the
same listing may be handled at the same time".

## Required sections

### 1. The question, in one sentence

What is being decided. If you cannot write it in one sentence, the research did not
converge and that is the finding to report.

### 2. Where both agents agreed

A short list. Agreement between two independently-run agents on the same
evidence is the strongest signal in the whole pipeline — surface it first, and treat
it as settled unless Matt says otherwise.

| Both agents found | Evidence |
|---|---|

### 3. Where they disagreed

| # | Ground said | Frame said | Why it matters |
|---|---|---|---|

"Why it matters" is what changes downstream. If nothing changes, it is not a real
disagreement — drop it to a footnote.

### 4. The decision flow

The part Matt actually uses. One block per open disagreement:

> **Question 1.** Should a duplicate delivery be dropped by the SDK, or left to the handler?
>
> | If you answer | Then we build | Which means |
> |---|---|---|
> | The SDK drops it | `onceById` runs before every handler, using a `kinesin_processed` table in the consumer's database | Every consumer needs that table; handlers stay simple |
> | The handler decides | `onceById` is opt-in per subscription | No table for naturally idempotent handlers; a forgotten opt-in double-applies an effect |
>
> **Recommended:** the handler decides — {one sentence why}.

Every option must map to a concrete build consequence. An option with no consequence
is not an option, it is a preference, and it should not be on the page.

### 5. What happens next

The one-line statement of what phase 2 will plan once Matt has answered. So Matt can see
what the answers buy.

## Design

Load the `artifact-design` skill before writing the page. Tables for every comparison,
bold labels, blank lines between groups. It is read on screen, fast.
