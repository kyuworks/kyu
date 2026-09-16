# Refactor Patterns

Load this file only when the split shape is unclear, a circular dependency appears, or you need edge-case guidance.

## Preferred patterns

### Sibling modules

Use for the relay, the outbox, the worker wrapper, and mixed logic/type files.

```text
relay.ts              (barrel — re-exports everything)
relay.batch.ts        (select pending rows, mark published, record errors)
relay.lock.ts         (advisory lock, single active instance)
relay.push.ts         (bulk push to Hatchet, backoff)
relay.types.ts        (shared types/interfaces if needed)
```

### Schema split

Use for a schema file that holds several unrelated message families.

```text
index.ts              (barrel — re-exports everything)
envelope.ts           (the envelope schema and its version rules)
metadata.ts           (tenant, correlation, causation, source fields)
naming.ts             (message-name parsing and validation)
```

### Handler helper extraction

Use for a durable handler with several concerns (wait logic, step
bookkeeping, error classification).

```text
followUp.ts               (barrel + orchestrator)
followUp.steps.ts         (step definitions)
followUp.waits.ts         (sleep and waitFor helpers)
followUp.errors.ts        (retryable vs non-retryable classification)
```

## Circular dependency handling

If module A and extracted module B need each other:

1. Identify the shared types, constants, or helpers.
2. Move those shared pieces into a neutral module such as `.types.ts` or `.shared.ts`.
3. Both A and B import from the neutral module.
4. Re-export through the original public path as needed.

```text
A.ts (original)  → imports from shared.ts
B.ts (extracted) → imports from shared.ts
shared.ts        → pure types/constants, no imports from A or B
barrel.ts        → re-exports from A, B, and shared
```

Do not solve circular dependencies by leaving duplicate logic in place.

## Edge cases

### Default exports

Preserve the default export at the old path:

```ts
export { default } from './MainComponent';
export { HelperPanel } from './HelperPanel';
```

### Side-effect imports

If consumers use `import './file'`, preserve the side effect at the original path by ensuring the barrel imports the module that carries the side effect.

### Tests that import internals

Prefer keeping test imports on the original public path (barrel). If tests intentionally reach non-exported internals:
1. Move the tested helper to its logical module
2. Add a test-only export if needed: `export { _internalFn as __test_internalFn }`
3. Update the test import to point to the new module

### Test file splitting

Do NOT split test files unless they are also oversized (1000+ lines). A single test file covering the barrel is fine. If tests DO need splitting, split along the same seams as the source.

### Generated files

Do not refactor generated files such as JSON Schema output generated from the Zod schemas, or build output under `dist/`. They will be overwritten.
