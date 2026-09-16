---
name: refactor
description: Use when splitting oversized files into smaller, focused modules. Accepts one or more file paths, establishes a green baseline (typecheck + tests), performs incremental file splits with re-exports for backward compatibility, and verifies after each split. No new behavior — only structural reorganization. Triggers on "/refactor <file-path>" or "/refactor" with a list of files.
---

# Refactor

Structural surgery on oversized files. The goal is **identical behavior in smaller, focused modules** — no new features, no behavior changes, no scope creep.

```
Input: file path(s) to split
         ↓
   CONVENTIONS     Read nearby files, match existing patterns
         ↓
   BASELINE        Typecheck + tests → must be GREEN before any changes
         ↓
   ANALYZE         Read the file, map exports/importers, identify seams
         ↓
   APPROVE?        Present strategy only when the split is ambiguous
         ↓
   SPLIT           Extract → remove from original → re-export → verify (per concern)
         ↓
   FINAL VERIFY    Full typecheck + test suite
         ↓
   SUMMARY         Report what moved where with before/after line counts
```

## When to Use

**Use when:**
- A source file exceeds ~500 lines and has multiple distinct concerns
- User says "refactor this", "split this file", "break this down"
- User provides a list of files to refactor
- `/refactor <file-path>` or `/refactor` followed by a list

**Do NOT use when:**
- The task involves changing behavior (implement the behavior change separately)
- The file is large but has a single cohesive concern (size alone isn't a reason)
- The user wants to rename/restructure entire directories (that's an architectural change)

## Inputs

Prefer explicit file paths. Accept one path, multiple paths, or no path when the target is unambiguous from conversation context. If the target is ambiguous, stop and ask.

## The Process

### 1. Inspect local conventions

Before proposing a split:
- Read the full target file
- Inspect nearby files in the same feature or directory
- Map the file's exports and major internal concerns
- Search for importers with grep
- Match existing local patterns before inventing a new structure

Look for:
- Sibling module suffixes such as `.batch.ts`, `.lock.ts`, `.types.ts`
- Package entry points (`packages/<pkg>/src/index.ts`) as barrels
- Existing barrel usage versus direct imports
- Default export patterns
- Test placement and naming (`*.test.ts` colocated; `*.integration.test.ts` for tests that need Hatchet or Postgres)

### 2. Establish a green baseline

Do not refactor on top of failing checks.

```bash
pnpm check:changed
```

That selects typecheck, lint, and the tests that own the files you are about
to split. If you need one package on its own:

```bash
pnpm --filter @kinesin/sdk typecheck
pnpm --filter @kinesin/sdk test
```

Do not run the integration suite for a baseline — it needs the Hatchet stack
and tells you nothing about a structural split.

**If baseline is RED, STOP.** Report the failures to the user and ask how to proceed.

### 3. Decide the split

Choose seams by concern, not by arbitrary line counts. Good seams usually separate:
- Orchestration from helpers (the relay loop from batch select, push, and mark)
- Write path from read path (outbox insert from pending-row queries)
- Schema definitions from the helpers that build or version them
- Shared types/constants from implementation

Prefer a small number of useful modules (aim for 200-500 lines each). Avoid scattering one cohesive file into many tiny files.

Present the proposed structure using this format:

```
## File: {path} ({N} lines)

### Current Exports
- {export1} — used by {file1, file2}
- {export2} — used by {file3}

### Proposed Split

#### {new-module-1}.ts (~{N} lines)
Concern: {description}
Moves: {function/type list}

#### {new-module-2}.ts (~{N} lines)
Concern: {description}
Moves: {function/type list}

#### {original-file}.ts (barrel — ~{N} lines)
Re-exports everything from new modules.
External consumers see no change.
```

Read [references/refactor-patterns.md](./references/refactor-patterns.md) for concrete split shapes, circular dependency handling, and edge-case guidance.

### 4. Approve (only when ambiguous)

Wait for explicit user approval only when:
- There are multiple reasonable seam placements
- Naming is unclear
- Barrel vs. direct-import conventions are inconsistent nearby
- The file is large enough that scope is unclear

If the requested refactor is straightforward and local conventions are clear, proceed after briefly stating the plan.

### 5. Extract one concern at a time

For each extraction, complete ALL of the following steps in order:

**Step A: Create the new module.**
Write the new file with the extracted functions/types/constants and all necessary imports.

**Step B: REMOVE the extracted code from the original file.**
Delete the functions, types, and constants that were copied to the new module. The code must NOT exist in both places. After this step, if you search for the function name in the original file, it should only appear in the re-export line (Step D), nowhere else.

**Step C: Import from the new module** (only if the original file still uses the extracted code internally).
```typescript
import { functionA } from './newModule';
```

**Step D: Re-export for backward compatibility.**
```typescript
export { functionA, functionB, TypeC } from './newModule';
```

Skip re-exports only when the user explicitly accepts import churn or when all impacted imports are clearly local and being updated together.

### 6. Guard against ghost code

After EVERY extraction, confirm all of the following before proceeding:

```
[ ] The extracted symbol is GONE from the original file body (Step B happened)
[ ] The new file contains the ONLY copy of the implementation
[ ] The original file re-exports from the new file (grep for "from './newModule'")
[ ] No duplicate definitions exist (symbol is defined in exactly one place)
[ ] The original file is shorter than before this extraction
```

Use grep to verify — do not rely on memory:

```bash
# Verify each extracted symbol is defined in exactly ONE file
grep -rn "export function symbolName\|export const symbolName\|export class symbolName\|export type symbolName\|export interface symbolName" path/to/directory/
```

**Expected:** Each symbol appears as a definition in exactly ONE file (the new module) and as a re-export in exactly ONE file (the barrel/original).

**If a symbol is defined in BOTH files:** Step B was skipped. Delete the duplicate from the original.

**If a symbol is defined in the new file but NOT re-exported:** Add the re-export (Step D).

**If a symbol is defined ONLY in the original:** The extraction didn't happen. Move it now.

### 7. Verify incrementally

After each extraction + ghost code check, run:

```bash
pnpm check:changed
```

A split adds new files, so the graph picks up the new owners on each run. If
you want to watch one test while iterating, run that file directly:

```bash
pnpm --filter @kinesin/sdk exec vitest run {path/to/relevant.test.ts}
```

Vitest is installed per package; bare `pnpm vitest` from the root does not
work.

**If RED:** Fix the issue before continuing. Common issues:
- Missing import in the new module
- Circular dependency between new module and original
- Type that was implicitly available via the original file's scope
- Relative import paths need adjusting

**If GREEN:** Proceed to the next extraction.

### 8. Final verification

After all splits are complete:

```bash
pnpm check:changed
```

A refactor changes structure, not behaviour, so the affected set is the
right scope — the same set the commit hook will run. Reach for `pnpm check`
(the exhaustive backstop) only if a split moved a module across package
boundaries (`AGENTS.md` § Package boundaries).

### 9. Summary

Report to the user:

```
## Refactoring Complete

### {original-file.ts} ({before} → {after} lines)
Split into:
- {new-module-1.ts} ({N} lines) — {concern}
- {new-module-2.ts} ({N} lines) — {concern}
- {original-file.ts} ({N} lines) — barrel re-exports

### Verification
- Typecheck: PASS
- Tests: {N} passed, 0 failed
- No external imports changed (backward compatible)
```

## Re-export rule

Default rule: **no external consumer should need to change their imports.**

Keep the original path working by turning it into a barrel:

```typescript
export { selectPendingBatch, markPublished } from './relay.batch';
export { withRelayLock } from './relay.lock';
export type { RelayOptions, RelayStats } from './relay.types';
```

## Guardrails

- Do not change behavior while splitting files.
- Do not combine renames with file extraction unless the user explicitly asks for both.
- Do not interleave splits across multiple files. Finish one file, verify it, then move on.
- Do not introduce circular dependencies. Extract shared types/constants into a neutral module first.
- Do not rewrite tests unless the existing test layout is itself part of the refactor.
- Do not leave dead code behind in the original file.
- Do not refactor generated files (JSON Schema generated from the Zod schemas, build output under `dist/`).

## Anti-Patterns

| Anti-Pattern | Why It's Wrong | Correct Approach |
|-------------|----------------|------------------|
| **Creating new file but not removing code from original ("ghost code")** | **New file is dead code — nothing imports it. Original is unchanged. You did nothing.** | **Step B is mandatory: DELETE the code from the original. Run the ghost code check (Step 6).** |
| Splitting into too many tiny files | 10 files of 50 lines each is worse than 1 file of 500 | Aim for 200-500 lines per module |
| Renaming functions while moving | Reviewing split + rename together is hard | Split first, rename in a separate step |
| Moving code without re-exports | Breaks every consumer | Always re-export from the barrel |
| Skipping verification between splits | A cascade of failures is much harder to debug | Verify. Every. Time. |
| Splitting behavior + structure in one PR | Reviewers can't tell what changed behavior vs. what moved | Structure-only PRs. Behavior in separate PRs. |
| "While I'm here" improvements | Scope creep kills clean refactoring | Resist. File an issue for the improvement. |
| Forcing direct imports when the area uses barrels | Inconsistent patterns confuse future readers | Match the surrounding convention |

## Checklist

Before reporting completion:

- [ ] Local conventions inspected and matched
- [ ] Baseline was GREEN before any changes
- [ ] Each extraction was verified individually (typecheck + tests)
- [ ] **Ghost code check passed for every extraction** — no symbol is defined in both the original and the new file
- [ ] All re-exports in place (no consumer import changes needed)
- [ ] **Original file line count decreased** — if it didn't shrink, the extraction didn't happen
- [ ] No circular dependencies introduced
- [ ] No behavior changes (same exports, same behavior)
- [ ] Final typecheck passes (`pnpm --filter <pkg> typecheck`)
- [ ] Final test suite passes (`pnpm --filter <pkg> test`)
- [ ] Summary reported to user with before/after line counts
