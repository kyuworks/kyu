# Agent Prompt Templates

Templates for the four agent roles in the plan skill. Use these verbatim (with placeholders filled in) when spawning teammates via `Task` with `team_name`.

All agents receive the `name`, `team`, and task id. All agents MUST be teammates — never standalone `Task` calls.

`{domain}` is one of the repository's areas: `schemas` (`packages/schemas`), `sdk` (`packages/sdk`), `infra` (`infra/`), `scripts` (`scripts/`), `docs` (`docs/`).

## Exploration Agent Template

```
You are "{name}" on team "{team}". Your task is Task #{id}: Explore {domain} for {feature}.

Read these files COMPLETELY (not snippets):
- {file list}

Also search for:
- All imports of {key modules} — use grep to find every call site
- All usages of {key types/interfaces}
- Related test files (`*.test.ts` beside the source, `*.integration.test.ts` for the Hatchet stack)

Report back with:
1. **Files read** — full path list
2. **Patterns found** — how does the codebase handle {similar functionality}?
3. **Dependencies** — what imports what? Map the dependency chain, including which package (`@qtaxis/schemas`, `@qtaxis/sdk`) each symbol lives in.
4. **Constraints** — types, Zod schemas, the envelope shape, the outbox SQL, the SDK public API — anything the plan must respect
5. **Conventions** — naming, folder structure, error handling patterns in this area

Mark task #{id} as completed when done.
```

## Planning Agent Template

```
You are "{name}" on team "{team}". Your task is Task #{id}: Plan {domain} changes for {feature}.

Context from exploration:
{paste exploration agent findings}

Requirements:
{paste requirements}

Draft your section of the plan following the Plan Document Structure (see plan-doc-template.md):
- Ground EVERY decision in specific file references — a path plus the symbol, heading, or a short quoted snippet, never a line number. Where the target genuinely has no name, quote enough of it to grep for.
- For each file you propose changing, explain WHAT changes and WHY
- Produce **Work Units** (WU-N) for your domain — each WU maps to one implementation agent
- Each WU MUST include: domain, agent scope, files, dependencies, acceptance criteria, audit focus, integration concerns, test requirements
- Acceptance criteria MUST be specific and testable (not "works correctly" — instead "`publish()` inside a rolled-back transaction leaves no `qtaxis_outbox` row")
- Identify risks and propose mitigations
- List tests that need updating or creating, and say which level each is (unit, integration against the local Hatchet stack, or manual with a reason)
- Trace impacts: what other files/packages are affected by your changes? Does a consumer of `@qtaxis/sdk` see a different public API or envelope shape?
- Estimate LOC and file count per WU so the PR Decomposition phase has real numbers to work with

Do NOT propose changes that contradict existing codebase patterns unless you explain why the deviation is justified.

Mark task #{id} as completed when done.
```

## Correctness Audit Agent Template

```
You are "{name}" on team "{team}". Your task is Task #{id}: CORRECTNESS AUDIT the plan for {domain}.

Read the plan section:
{paste planner output}

Now READ THE ACTUAL FILES referenced in the plan. Not the plan's description of them — the real files. Verify:

1. **Codebase alignment** — does the plan follow the patterns you see in the code?
2. **Claim verification** — every file reference — is it accurate, and anchored by symbol/heading/snippet rather than a line number?
3. **Impact analysis** — grep for all imports/usages of changed modules. Trace every call site.
4. **Technical critique** — is there a better approach? A simpler path? A pattern already in the codebase?
5. **Missing pieces** — what did the planner forget? Types? Tests? An outbox migration SQL file under `packages/sdk/migrations/`? Error handling? A `NonRetryableError` where a retry would never help?
6. **Risk assessment** — what could go wrong?
7. **PR decomposition sanity** (if a PR Plan is present) — see pr-decomposition.md for the criteria

For EVERY finding, provide:
- Exact file path and line number
- Evidence from the actual code
- Severity: critical / major / minor
- Recommended fix

Mark task #{id} as completed when done.
```

## Integration Audit Agent Template

```
You are "{name}" on team "{team}". Your task is Task #{id}: INTEGRATION AUDIT of correctness audit #{audit_id}.

Read the correctness audit report:
{paste correctness audit output}

Read the original plan section:
{paste plan section}

Now do your OWN independent verification:
1. Pick 3 claims from the plan — read the actual files and verify them yourself
2. Pick 2 impacts the correctness auditor identified — verify the call sites exist
3. Check: did the correctness auditor cover ALL dimensions (alignment, claims, impact, critique, missing pieces, risks, PR decomposition)?
4. Trace cross-cutting concerns: the envelope shape, the outbox migration, delivery semantics (idempotency, ordering, business tenant metadata), the SDK public API — does the plan fit?
5. If a PR Plan is present: verify each PR's "Proves" claim is achievable with only that PR's WUs
6. Identify anything the correctness auditor missed or got wrong

Report:
- Correctness audit thoroughness: [thorough / adequate / superficial]
- Issues the correctness auditor missed: [list or "none"]
- False positives from correctness auditor: [list or "none"]
- Cross-cutting concerns: [list or "none"]
- PR Plan issues (if applicable): [list or "none"]
- Confidence level: [high / medium / low]
- Recommendation: [plan is ready / plan needs revision / plan needs major rework]

Mark task #{id} as completed when done.
```
