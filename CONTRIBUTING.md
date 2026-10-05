# Contributing to Kyu

Kyu is the company message bus (public at [`kyuworks/kyu`](https://github.com/kyuworks/kyu)). Rules for agents and people are in [`AGENTS.md`](AGENTS.md); shared words in [`CONTEXT.md`](CONTEXT.md); the design in [`docs/design/kyu-requirements-and-design.md`](docs/design/kyu-requirements-and-design.md); decisions in [`docs/architecture/adr/`](docs/architecture/adr/).

Issue and pull request numbers quoted in documents, ADRs and proof pages dated before 2026-10-01 refer to the archived private repository the project moved from, not to this repository. The three issues still open at the move were re-created here as #1 (workflow interpreter umbrella), #2 (release path) and #3 (failure alerts, deferred).

## People

| Person | Role |
| --- | --- |
| Matt Demler (`@matt-camba`) | Owner. Merges. Decides scope and architecture. |
| Product reviewer | Reviews product. |
| Architecture reviewer | Reviews architecture. |

## Issues

Work is tracked as GitHub issues in this repository. Every PR closes an issue when practical. Keep the issue current: investigation, decisions, tests, verification and the PR link go on the issue as comments. The PR describes the change; the issue chronicles the work.

Write issues and PRs in plain language: simple words, no assumed context, first sentence is the ask ([`iso-24495`](.agents/skills/iso-24495/SKILL.md)).

## Setup

```bash
pnpm install
pnpm hatchet:up                      # local engine: http://localhost:8888 (admin@example.com / Admin123!!)
export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/token.sh)"
export HATCHET_CLIENT_TLS_STRATEGY=none
export KYU_TEST_DATABASE_URL=postgresql://hatchet:hatchet@localhost:15432/kyu_test
export KYU_TEST_POOLER_DATABASE_URL=postgresql://hatchet:hatchet@127.0.0.1:16432/kyu_test
pnpm check                           # exhaustive local check
```

Node 24 or newer, pnpm 11, Docker for the engine. Secrets never live in files; the only local secret is the engine token above, which is disposable.

## The loop

1. Branch from `main`: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`.
2. Write the failing test first when behavior changes. Watch it fail.
3. Implement the smallest correct change.
4. `pnpm check:changed` while you work. The pre-commit hook runs it on staged files; that run is the checkpoint. Never `--no-verify`.
5. Open a PR against `main` with the template filled in. Hosted CI runs the required checks ([`REQUIRED.md`](.github/workflows/REQUIRED.md)).
6. A reviewer who did not write the change approves. Matt merges.

Agents follow the fuller pipeline in [`.agents/skills/`](.agents/skills/): `/ship` for a feature end to end, `/next` to resume.

## Layout

| Path | What |
| --- | --- |
| `packages/schemas` | `@kyuworks/schemas`: envelope, naming rules, schema adapters. Zod only. |
| `packages/sdk` | `@kyuworks/sdk`: publish + outbox, relay, subscribe, durable handlers, worker. Ships `migrations/` for consumers. |
| `infra/hatchet` | Local engine stack (Docker Compose) and, later, the Fly deployment. |
| `scripts/` | `check.sh`, `check-changed.sh`, `verify-gates.sh`, `gates/*` with their `*.test.sh`, `hooks/` (agent guard). |
| `oxlint-rules/` | Shared lint presets, including the anti-slop plugin. |
| `.agents/skills/` | Agent pipeline skills. `.claude/skills` is a symlink here. |
| `docs/` | Design, ADRs. |

## Gates

A gate is a script under `scripts/gates/` that fails the commit or the PR. Each has a colocated `*.test.sh`. When a review comment would be repeated, add a gate instead. Do not weaken one to land a change.

| Gate | Fails when |
| --- | --- |
| `check-pr-size.sh` | more than 400 net production lines added (label `oversized-justified` plus a reason line is a human's hatch) |
| `check-migration-immutability.sh` | a file under `packages/sdk/migrations/` already on `main` is edited, renamed or deleted |
| `check-no-escape-hatches.sh` | `as any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error` or a disable comment in production source |
| `check-no-pipe-to-grep-q.sh` | a shell script under `scripts/`, `.agents/`, `.husky/` or `infra/` pipes into `grep -q`, `-m`, `-l` or `-L`, also across a backslash-newline (read a here-string instead); a pipe into grep with output to `/dev/null` is allowed, because GNU grep then reads the whole pipe |
| `check-durable-wall-clock.sh` | `Date.now` (called or passed) or an argument-less `new Date()`, even with its `)` on the next line, in a production file that holds a durable handler; a grep error also fails it |
| `check-package-boundaries.sh` | a package imports another by relative path or deep `src`/`dist` path, or a file in `packages/sdk` other than `src/hatchet.ts` and its test imports `@hatchet-dev/` in any form |
| `check-package-versions.sh` | the published packages' versions or `SDK_VERSION` differ, the SDK's range on schemas is not `workspace:*`, or (release only) the tag is not `v<version>` |
| `check-package-exports.sh` | a package tarball lacks a file its `main`, `types` or `exports` names, or a file from its `migrations/` |
| `check-required-ci-jobs.sh` | `required-checks.txt` names a check that is not the `name:` (else the job id) of a job in a workflow that runs on `pull_request`; a job with a matrix or one that calls a reusable workflow counts for no name; a workflow file fails the shared YAML reader (`workflow-yaml.mjs`, which also rejects an upper-case `.YML` extension) |
| `check-oidc-jobs-skip-cache.sh` | a job that can publish (`id-token: write` or `write-all`, its own `permissions` or the workflow's) lacks `cache-mode: none`, uses the setup action without `cache: 'false'`, uses `actions/cache` directly, or calls a reusable workflow; a workflow that relaxes the release-age rule lacks a top-level `cache-mode: none`, or an action relaxes it; a workflow file has an upper-case `.YML` or `.YAML` extension; a workflow or action file does not parse, holds other than one YAML document, repeats a key (in any letter case), has a key that is not a string, a merge key, a tag, a `%YAML` or `%TAG` directive, an alias with no anchor or too many aliases, or a `permissions` or `id-token` value it cannot read |
| `check-agent-ship-loop.sh` | an agent PR body has an incomplete ship-loop section (the Ship loop workflow; `verify-gates.sh` when `PR_BODY_FILE` is set) |
| `check-engine-image-tag.sh` | a `hatchet-lite` reference in `infra/hatchet/fly/fly.toml` or in any string of a YAML file under `.github/` (workflows and actions, read with the `yaml` package, `run:` text included) names a tag other than the default in `infra/hatchet/compose.yaml`; that default is not a `vX.Y.Z` release; a file names two tags, an untagged image, or a tag the gate cannot read; compose.yaml names the engine in any shape but that default as an `image:` value; compose.yaml or a YAML file under `.github/` fails the shared YAML reader; or `ci.yml`, `newest-client.yml`, `compose.yaml` or `fly.toml` is missing |

## Releases

Tag-driven, from `main`. See [Releasing](README.md#releasing).
