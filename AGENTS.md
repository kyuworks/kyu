# Agent notes — Kyu

This repository is **Kyu** (`kyuworks/kyu`; moved from a private company repository on 2026-10-01): the company message bus, built on self-hosted Hatchet. It is a TypeScript library plus deployment config, consumed by every company project through its SDK. Do not open issues, PRs or automation against any other repository from here.

Read this file in full before any task. It applies to every harness, not only Claude Code. Shared words: [`CONTEXT.md`](CONTEXT.md). The design: [`docs/design/kyu-requirements-and-design.md`](docs/design/kyu-requirements-and-design.md). Decisions: [`docs/architecture/adr/`](docs/architecture/adr/).

## Current mission

Ship the SDK, then prove it with a test application. In order: the envelope and message definitions (`packages/schemas`), the outbox and `publish()`, the relay, the subscribe and durable helpers (`packages/sdk`), then a test application, the shop example in [`kyuworks/shop-example`](https://github.com/kyuworks/shop-example), that exercises events, commands and durable handlers end to end. The design document's phases are the roadmap; GitHub issues are the queue.

**Non-goals until explicitly scheduled:** a dashboard of our own, non-TypeScript SDKs, a Hatchet fork, multi-region, synchronous request/response over the bus.

## Speed and quality

Agents write most of the line-count. Throughput is set by **feedback latency and how unambiguously the repo tells them they are wrong**, not by model quality. Keep the discipline: oxlint at error, gates, immutable migrations, `pnpm check:changed`. If you make an error, consider adding a gate so the next agent cannot.

| Goal | What to do |
|---|---|
| Fast, decisive verify | `pnpm check:changed` for the normal loop; `pnpm check` as the exhaustive backstop. Silent on success. First failure + log path. |
| Wrong is loud | Prefer a gate over a repeated review comment. Do not weaken a gate to land a change. |
| Contracts first | The envelope in `packages/schemas` is the public contract. Implement against it. Do not invent a parallel shape. |
| Bounded work | One concern per PR. Shared-file work is sequential. Target ≤ 400 net production additions (`check-pr-size.sh`). If that gate would fail, stop and split. Do not apply `oversized-justified` yourself. |
| First-attempt readable | One owner per boundary. Small public APIs. Colocated tests. Boring code. Exported names carry a domain noun: `parseEnvelope`, not `parse`. |
| Comments | Rare. One or two lines: a constraint the next line cannot express, or a pointer to the gate that enforces it. No work-unit ids, no investigation replay, no "single source of truth". If it needs a paragraph, it is an ADR or it is wrong. |
| Call stacks before code | A plan that adds or edits a publish path, a handler, a relay step, or a webhook lists each layer: input type, output type, errors, side effects. Decode once at the trust edge (`publish()` input, Hatchet event payload, webhook body). Interior functions take the parsed envelope. Re-parsing a value the layer above already parsed is a failed plan. |
| Encode the last failure | After a session that widened a type, re-parsed a parsed value, or invented a parallel DTO, add a gate or lint rule plus a fixture before the next feature. |

Do not merge red. PRs land on `main`. Short-lived feature branches.

## Agent loop

Quiet commands. `pnpm check:changed` and the commit hook print nothing on success. On failure they print `FAILED`, the first error, and a log path under `.artifacts/check/`. Do not run `vitest` / `pnpm test` / `pnpm check` by hand as a "done" step. Do not paste logs into chat; open the log path if you need the failure.

**Issue workflow:** flag a contract or migration change first. Plan in a subagent (high reasoning). Execute in a different subagent (low reasoning). Review in a third subagent that has not seen the plan (high reasoning). If `codex` is on PATH, run `codex review` as its own process and take the verdict. Open a PR, print the URL, and **stop**. Do not wait for GitHub Actions in this session. One issue per session; start a new session after the PR.

The pipeline skills live in [`.agents/skills/`](.agents/skills/) (`.claude/skills` is a symlink): `/ship` drives research → plan → prereq → build → verify → review → wrap → open-pr; `/next` resumes at the detected phase. Reference: [`.agents/skills/_pipeline/README.md`](.agents/skills/_pipeline/README.md).

Amend: you may `git commit --amend` when HEAD is **not on the remote** and you authored it. Never amend someone else's commit. Never force-push.

If `check-pr-size.sh` would fail, stop and split the PR.

Plain language on issues and PRs: simple words, no assumed context, no metaphors. First sentence is the ask or the change ([`iso-24495`](.agents/skills/iso-24495/SKILL.md)).

## Agent ship loop

Humans may shortcut a tiny PR (typo, docs-only, rename). Agents may not claim done without this loop:

1. **Plan** — if the change adds or edits a publish path, handler, relay step, or webhook, write the call stack first ([plan skill](.agents/skills/plan/SKILL.md) § Call stacks). Otherwise one line: `N/A` and why.
2. **Red must-hold** — name what must stay true, then watch one test fail before the production change ([must-hold](.agents/skills/must-hold/SKILL.md)). Docs / lint / rename / generated-only may mark N/A.
3. **Smallest diff** — see Smallest correct change below.
4. **`pnpm check:changed`** — the commit hook counts. This step is not "done".
5. **Separate review** — a different agent or `codex review`, not the author ([pr-review](.agents/skills/pr-review/SKILL.md)).
6. **Hosted CI** — open the PR and stop. Do not claim merge-ready from a local green.

Fill `## Agent ship loop` on the PR. A human deletes that heading. `scripts/gates/check-agent-ship-loop.sh` fails an incomplete agent body and passes a human body with no heading.

## Pre-work

1. **Read surgically** — only files the task needs.
2. **Know blast radius** — grep callers before editing shared symbols. `packages/schemas` is imported by everything; a change there reaches every consumer.
3. **Then implement** — targeted edits; tests when behavior changes.

## Smallest correct change

Before writing code, stop at the first rung that holds:

1. **Skip it** if it is not in the request and not required by the contract.
2. **Reuse or extend what exists.** Grep `packages/*/src` for a helper, schema, or type. If one is close, extend it rather than adding a sibling, and say so.
3. **Use the platform we already have** — Hatchet's own concurrency keys, rate limits, durable waits, schedules; Zod; Node stdlib — before writing our own.
4. **Use an already-installed package.** Do not add a dependency for a few lines. A new dependency is a decision: say why in the PR.
5. **Then the smallest diff in the right place.**
6. **Leave one colocated test** that fails if the behavior is reverted. Never skip envelope validation or the outbox transaction boundary.

## Architecture

**Packages**

- `packages/schemas` (`@kyuworks/schemas`): the envelope, naming rules, Standard Schema adapter. Zod only. No Hatchet, no I/O.
- `packages/sdk` (`@kyuworks/sdk`): `publish()` and the outbox, the relay, `subscribe()` / `durable()` over the Hatchet SDK, `onceById()`, the worker. Ships `migrations/` SQL for consumers.
- `infra/hatchet`: the local engine stack and, later, the Fly deployment.
- Consumers never call the Hatchet SDK directly for bus work. If the SDK lacks something, add it to the SDK.
- The shop example lives in `kyuworks/shop-example` and installs the published packages. A daily workflow there runs it against this repository's `main`; a red run there is an SDK regression until shown otherwise. `examples/*` stays open for a future example; the gates still scan it. A new example also needs the `examples/*` entry put back in `pnpm-workspace.yaml`.

**Delivery rules**

- The envelope is the contract. `data` carries ids and small discriminators. No personal data enters Hatchet.
- `publish()` writes the outbox row inside the caller's transaction and returns. The relay ships it. Nothing else calls the engine on the publish path.
- Delivery is at-least-once. Every handler is idempotent on the envelope id: naturally, or through `onceById()`.
- Ordering is per key, declared on the subscription. There is no global order.
- A failed run is the dead letter. It is alerted on and replayable. Nothing swallows it.
- Business `tenantId` is metadata on the envelope. It drives filters, concurrency keys and rate limits. Consumers open their own tenant-scoped data access from it. The bus never reads tenant data.
- Bus tenant (a Hatchet tenant) is one per company project per environment. Cross-project traffic is an explicit relay, never a shared tenant.

## Migrations

- `packages/sdk/migrations/<YYYYMMDDHHMMSS>_<slug>.sql`. Consumers apply them with their own runner.
- Write new files only; never edit, rename, or delete a file that exists on `main`. Revert with a new file. Gate: `check-migration-immutability.sh`.
- Timestamp with `date +%Y%m%d%H%M%S`, greater than the latest file.

## Lint

**oxlint** (`.oxlintrc.json` per package, presets in `oxlint-rules/`). Every rule is **`error`**. Type-aware `typescript/*` runs through `oxlint-tsgolint`. The anti-slop preset (`oxlint-rules/anti-slop.oxlintrc.json`) bans widened types, chained assertions, runtime `typeof` checks and `unknown` at boundaries. Do not silence a rule; fix the code. Unused disable directives are an error, and `scripts/gates/check-no-escape-hatches.sh` fails `as any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error` and disable comments in production source. Type-aware lint needs the workspace built (`pnpm build`) whenever a package imports another's types, so it resolves real types instead of `any`; CI's Lint job builds first for this reason.

**oxfmt** formats. `pnpm format` fixes, `pnpm format:check` gates.

## Package boundaries

A package reaches another only through its package name and exports map. No relative import out of a package; no `@kyuworks/<pkg>/src/...`. Gate: `check-package-boundaries.sh`. `packages/schemas` depends on nothing in the workspace. `packages/sdk` depends on `@kyuworks/schemas`. An example under `examples/*` imports `@kyuworks/sdk` only, never `@hatchet-dev/` or `@kyuworks/schemas` directly; the same gate fails any import form (`from`, bare `import '...'`, dynamic `import('...')`, `require('...')`) and the dependency itself in `package.json`, not just one spelling of it. Inside `packages/sdk`, only `src/hatchet.ts` imports `@hatchet-dev/` (and `src/hatchet.test.ts`, which checks the wrapper against the real package); the same gate fails any other file, tests included. Add a package only with an ADR.

## Running commands

```bash
pnpm check:changed          # normal loop (silent on success)
pnpm check                  # exhaustive backstop
pnpm hatchet:up             # local engine (Docker): http://localhost:8888, gRPC :7077, PgBouncer :16432
bash infra/hatchet/token.sh # worker token for the local engine
pnpm --filter @kyuworks/sdk test:integration   # needs the engine, HATCHET_CLIENT_TOKEN, KYU_TEST_DATABASE_URL and KYU_TEST_POOLER_DATABASE_URL
```

Integration tests read `HATCHET_CLIENT_TOKEN`, `HATCHET_CLIENT_TLS_STRATEGY=none`, `KYU_TEST_DATABASE_URL` (e.g. `postgresql://hatchet:hatchet@localhost:15432/kyu_test`) and `KYU_TEST_POOLER_DATABASE_URL`, the same database through the stack's transaction-mode PgBouncer (e.g. `postgresql://hatchet:hatchet@127.0.0.1:16432/kyu_test`). They fail loudly when the engine, the database or the pooler is missing. They never skip.

## Who runs which tests

The commit is the verification checkpoint. `.husky/pre-commit` runs `scripts/check-changed.sh --staged`.

| Moment | What runs | Who triggers it |
|---|---|---|
| Mid-work, as often as you like | `pnpm check:changed` | You, for feedback on what you just wrote |
| Every commit | `check:changed --staged` | The hook |
| Every PR | Lint, Type Check, Unit Tests, Integration Tests (1/2), Integration Tests (2/2), Gate Self Tests, Ship loop | Hosted Actions ([`REQUIRED.md`](.github/workflows/REQUIRED.md)) |
| Push to `main` | The same six plus Build | Hosted Actions |

**Do not run `check:changed` as a final "am I done" step** — the commit runs it on staged files. **Do not run a full suite locally**; CI owns exhaustive coverage. Iterating on one test file is feedback, not verification: `pnpm --filter @kyuworks/sdk exec vitest run <file>`.

## Test-driven changes

Behavior-affecting code: tests first when practical; at minimum tests before claiming done.

Before writing tests for a publish path, handler, relay step, webhook, retry, crash-recovery, or a bugfix, run [`must-hold`](.agents/skills/must-hold/SKILL.md): name what must stay true, then implement one check. The mandatory rows for this repository: **redelivery of the same envelope id is idempotent**, **a message published in a rolled-back transaction is never delivered**, **the business tenant id reaches the handler unchanged**, **per-key ordering holds under concurrency**.

A new test that still passes after reverting the production change does not count. Watch it fail, restore, watch it pass. Do not claim done on a test you never saw go red.

Levels: unit (`*.test.ts`, colocated), integration (`*.integration.test.ts`, against the local engine), manual (justified, listed). There is no browser level.

Every SDK integration file starts from empty `kyu_outbox` and `kyu_processed`, because `packages/sdk/vitest.integration.clearBusTables.ts` runs before each file. A file must still clean up after itself rather than rely on the next one.

A suite that builds a git repository sources `scripts/lib/git-env.sh` and unsets the variables it lists. The gate `check-selftest-git-isolation.sh` fails one that does not.

A shell script feeds `grep -q` (and `-m`, `-l`, `-L`) from a here-string (`grep -q PATTERN <<< "${text}"`), never a pipe: under `pipefail` the early exit breaks the writer and a match reads as a miss. The gate `check-no-pipe-to-grep-q.sh` fails a pipe.

## Branch / PR defaults

- Only long-lived branch: **`main`**. PRs target `main`. Branches: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`.
- Issues and PRs in plain language. Shape: [`iso-24495`](.agents/skills/iso-24495/SKILL.md).
- After `gh pr create`, print the URL and **stop**. Do not sit on CI.
- Unattended (`CLAUDE_CODE_REMOTE=true`): draft PRs only, explicit `--base main`, never merge, never `gh pr ready`, never change issue state, never push to `main`. `scripts/hooks/agent-guard.sh` denies these regardless of what a skill believes.
- Matt merges. Not the pipeline, not an agent, not on any instruction that did not come from Matt in chat.
