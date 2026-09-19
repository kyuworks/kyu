---
name: prereq
description: Phase 3 of the feature pipeline. Sets up the base before any implementation — finds the project's real test commands, cuts the feature branch, creates a feature GitHub issue from the plan minus its execution steps with one sub-issue per planned PR, or fills in the epic's child when /epic hands one over, writes the tests from the testing sub-plan, and records them failing for the right reason (RED₁). Use when Matt says "/prereq", "set up the base", "create the issue", or when a plan exists and the build has not started. Writes tests but never implementation.
---

# Prerequisites — phase 3

The base the whole build is measured against. Four things exist at the end of it: real
commands, a branch, an issue, and a suite of tests that fail.

```
3.1  COMMANDS   read the project's own scripts — never assume
3.2  BRANCH     feat/{slug}
3.3  ISSUES     the feature issue, plus a sub-issue per PR in the plan
3.4  RED₁       write the tests, watch them fail for the right reason
```

Requires `planning-gitignored/plans/{slug}.md` and `planning-gitignored/plans/{slug}-testing.md`. Without both, stop
and route to `/plan` — there is nothing to write tests against.

---

## 3.1 — Find the real commands

The real commands live in the root `package.json` and in each package's `package.json`.
Read both — the root scripts fan out with `pnpm -r`, and the per-package scripts are what
actually run.

```bash
node -e "const s=require('./package.json').scripts;Object.entries(s).filter(([k])=>/test|integration|check|lint|typecheck|hatchet/.test(k)).forEach(([k,v])=>console.log(k,'=',v))"
for p in packages/*/package.json; do echo "== $p"; node -e "const s=require('./$p').scripts;Object.entries(s).filter(([k])=>/test|typecheck|lint/.test(k)).forEach(([k,v])=>console.log(k,'=',v))"; done
```

Record the values in the testing sub-plan's command table: unit, integration, typecheck,
lint. There is no browser level in this repository — anything a test cannot reach is
**Manual**, with a reason. Note any script whose body is `true` or whose name starts with
`_` — that is the convention for a placeholder, and running a dead command and calling it
a pass is a real failure mode.

In **Kyu** the loop is `pnpm check:changed` (silent on success; on failure prints
`FAILED`, the first error, and a log path under `.artifacts/check/`), with `pnpm check` as
the backstop. Per package: `pnpm --filter @kyuworks/sdk test` for unit,
`pnpm --filter @kyuworks/sdk test:integration` for integration,
`pnpm --filter @kyuworks/sdk typecheck`, and `pnpm lint` at the root. Vitest is installed
per package — bare `pnpm vitest` from the root does not work.

**Confirm the Hatchet stack boots** before promising integration evidence: run
`pnpm hatchet:up`, then `pnpm --filter @kyuworks/sdk test:integration` must be able to
connect. Integration tests need the Hatchet Lite + Postgres stack from
`infra/hatchet/compose.yaml`. Find that path now, not in phase 5 when the report is due.

---

## 3.2 — Branch

```bash
git fetch origin main
git checkout -b feat/{slug} origin/main
```

Off `origin/main` — there is no other long-lived branch. If the working tree is dirty,
commit it first and say so; never carry unrelated changes into a feature branch.
Unattended, `git stash` is denied by the guard, so a dirty tree is a stop, not something
to work around.

**Multi-PR features get a branch per sub-issue**, cut in phase 4 as each one starts:
`feat/{slug}-{sub-slug}`. This first branch is where the RED₁ tests live, and it is the
base the others come off when they depend on it.

---

## 3.3 — The feature issue and its sub-issues

**Template:** [`issue.md`](.agents/skills/_pipeline/templates/issue.md).
**Wording:** invoke the `iso-24495` skill. Plain language is a gate here, not a preference.

Two levels. The feature issue is the contract for the whole feature; each sub-issue is
the contract for one PR. The word *epic* means a cluster of features tracked as a parent issue;
when this feature is a child of one, 3.3f applies and nothing is created here.

Issues are created with `gh issue create`. The GitHub MCP may not be available, so do not
depend on it.

### 3.3a — No issue type

The **Epic** type names a cluster of features; there is no epic driver skill here. A feature issue is
not one: leave the type unset and use labels. Never guess a type name.

### 3.3b — The feature issue

Built from the engineering plan plus the testing sub-plan, **minus the execution steps**.
Full template, all sections. It carries everything that does not decompose:

| Section | Why it lives on the feature issue |
|---|---|
| Problem | Stated once. Sub-issues inherit the context rather than restating it |
| What NOT to do | Non-goals apply to every PR; repeating them invites drift between them |
| Solution | The whole design. A sub-issue shows only its slice |
| User flows covered | The complete inventory — the checklist that proves nothing was dropped |
| Acceptance criteria | Every criterion, grouped by level, each tagged with the sub-issue that owns it |
| Proof standard | RED₁ / GREEN / RED₂, stated once |

Write the body to a file under `planning-gitignored/` and create it:

```bash
gh issue create --title "{feature}" --body-file planning-gitignored/plans/{slug}-issue.md
```

Record the number the command prints.

### 3.3c — The sub-issues

**One per PR in the plan's PR Plan** — not one per work unit. A sub-issue is a thing that
merges; a work unit is not.

Each body starts with a `Part of #{feature issue}` line. That line is the link — `/open-pr`
carries it into the PR body, and the feature issue lists its children back. Do not try to
attach the issue through the GitHub sub-issues API instead: unattended, the guard denies
API writes, and the line is enough.

```bash
gh issue create --title "{feature}: {what this PR does}" --body-file planning-gitignored/plans/{slug}-sub-{n}.md
```

Each body is short and carries only what is its own:

- **`Part of #N`** — the first line, always
- **Scope** — the files and work units this PR touches, from the plan's execution steps
- **Acceptance criteria** — the slice of the feature issue's AC this PR must satisfy, copied verbatim so it stays checkable in place
- **Depends on** — `#N` for any sub-issue that must merge first
- **Proof** — the tests covering this slice, named, with their level (unit / integration / manual)

Do not restate the problem or the design. Link the feature issue and let a reader follow it.

### 3.3d — When the plan has only one PR

Say so, and offer to collapse. A single-PR feature does not need a feature issue plus one
child repeating it — one issue is clearer. Create the pair only if Matt wants the structure
anyway. Do not decide this silently in either direction. Unattended: one issue, recorded.

### 3.3e — Detail gate

Before writing a single test in 3.4, check the feature issue and every sub-issue against the
template — not that each section exists, but that each is filled with real content. A
vague acceptance criterion here becomes an untestable one in 3.4.

- [ ] Feature issue Problem states what a producer or consumer cannot do today and what it costs — not a symptom, not a file path
- [ ] Feature issue What NOT to do gives a reason per item — no reason means it is a preference, not a non-goal
- [ ] Feature issue Solution names actual files, contracts, and data flow — not "TBD", not a restatement of the problem
- [ ] Feature issue User flows covered matches the plan's inventory — nothing merged or dropped silently, and the four mandatory rows (idempotent redelivery, rolled-back publish never delivered, business tenant id unchanged at the handler, per-key ordering under concurrency) are present
- [ ] Every feature-issue acceptance criterion is a checkable assertion with a subject and an observable outcome — not "works correctly" or "handles errors"
- [ ] Every feature-issue acceptance criterion is tagged with the sub-issue that owns it
- [ ] Each sub-issue's Scope names the specific files or work units it touches — not "implement the feature"
- [ ] Each sub-issue's Acceptance criteria are copied verbatim from the feature issue's slice — not paraphrased, not re-derived
- [ ] Each sub-issue's Depends on is explicit — `#N` or "Nothing — this can merge on its own"
- [ ] Each sub-issue's Proof table names real test files or paths, not "TBD"

Fix the issue body (`gh issue edit N --body-file …`), not the test, when a box fails. Do
not proceed to 3.4 with an open box.

### 3.3f — When the feature is a child of an epic

When Matt hands over a child of an epic by number, **the child is the feature issue** — create nothing at
this level. Fill in whichever of 3.3b's sections its body lacks and keep its Working
agreement table. Add PR sub-issues under it only when the plan has more than one PR;
with one PR the child stands alone.

### Then

Update the feature issue body with the sub-issue list (`gh issue edit N --body-file …`),
so traceability runs both ways: feature AC → sub-issue, sub-issue → feature issue.

Record the numbers. The **sub-issue** number goes in that PR's branch name, its commits,
and `Closes #NNN` in its body. The **feature issue** is closed by Matt once every child
closes — never close it from an agent, and never change any issue's state unattended (the
guard denies it).

## 3.4 — RED₁

Write every test in the coverage matrix. No implementation. None.

Writing tests before the code is the whole reason this phase exists. Tests written
afterwards get shaped by the implementation, and then they pass because they describe
what the code does rather than what the issue requires.

Unit tests are colocated `*.test.ts`. Integration tests are `*.integration.test.ts` and
run against the Hatchet stack from 3.1.

Run them. Each one must fail **on its assertion**.

> A test that fails on an import error, a missing fixture, a typo, or a module that does
> not exist yet is **broken, not red.** Stub the module so it resolves and returns
> something wrong, then re-run. Only an assertion failure counts as RED₁.

That distinction is the point of the phase. An import error proves nothing about whether
the test can detect the feature being absent — it only proves the file is missing.

Record in the sub-plan's ledger, per test: the command, the actual output, and the
assertion that failed. No pasted output means no RED₁, and phase 5 will not credit it.

```bash
git add -A && git commit -m "test: red for #{NNN} — {feature}"
```

The pre-commit hook runs `check:changed --staged`. Never `--no-verify`. If the hook fails
on the new tests, fix them — a RED₁ test still has to typecheck and lint.

---

## Gate

Report and stop:

- Feature issue number and link, then each sub-issue number with its one-line scope
- Branch name
- Test count, and the commands they run under
- **Any test that could not be made to fail on its assertion** — this is the one that
  matters. It means either the test is wrong or the feature already exists

Do not start building. `/build` is a separate decision.

## What this skill never does

- Write implementation code — that is phase 4, and doing it here destroys RED₁
- Weaken a test to make it fail more conveniently
- Record a red without pasted output
- Close the feature issue or any sub-issue
