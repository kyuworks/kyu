# Contributing to Kinesin

Kinesin is the company message bus ([`Camba-nz/kinesin`](https://github.com/Camba-nz/kinesin)). Rules for agents and people are in [`AGENTS.md`](AGENTS.md); shared words in [`CONTEXT.md`](CONTEXT.md); the design in [`docs/design/kinesin-requirements-and-design.md`](docs/design/kinesin-requirements-and-design.md); decisions in [`docs/architecture/adr/`](docs/architecture/adr/).

**This is not Camba.** Do not file issues or PRs against the consuming project's repository from here.

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
| `packages/schemas` | `@kinesin/schemas`: envelope, naming rules, schema adapters. Zod only. |
| `packages/sdk` | `@kinesin/sdk`: publish + outbox, relay, subscribe, durable handlers, worker. Ships `migrations/` for consumers. |
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
| `check-package-boundaries.sh` | a package imports another by relative path or deep `src`/`dist` path |
| `check-required-ci-jobs.sh` | `required-checks.txt` names a job that is not in `ci.yml` |
| `check-agent-ship-loop.sh` | an agent PR body has an incomplete ship-loop section (CI only) |

## Releases

The SDK publishes under the `@kinesin` npm scope from `main` on a tag. Not wired yet; tracked as an issue.
