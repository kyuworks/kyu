# Required CI checks

Status-check names that must pass on a pull request into `main`. Machine
list: [`required-checks.txt`](./required-checks.txt). Hosted Actions is the
exhaustive gate; the Husky pre-commit hook is the local quick loop.

GitHub matches the job `name:` string, not the job id. Renaming a `name:`
unhooks branch protection until an admin updates the ruleset **and** this
list. `scripts/gates/check-required-ci-jobs.sh` (in the Lint job) fails the
PR if `required-checks.txt` drifts from `ci.yml`.

| Job id | Check name | What it runs |
| --- | --- | --- |
| `lint` | Lint | `pnpm format:check`, `scripts/verify-gates.sh --range <base>...HEAD`, `pnpm lint` |
| `typecheck` | Type Check | `pnpm typecheck`, `pnpm typecheck:tests` |
| `test-unit` | Unit Tests | `pnpm test` (every package's vitest unit suite) |
| `test-integration-sdk-1`, `test-integration-sdk-2` | Integration Tests (1/2), Integration Tests (2/2) | Each: its own Hatchet Lite + Postgres service containers, a worker token minted in the job, then `pnpm --filter @kyuworks/sdk test:integration` with `KYU_INTEGRATION_SHARD` 1 or 2 |
| `self-tests` | Gate Self Tests | `scripts/verify-self-tests.sh` — every `*.test.sh` under `scripts/` and `.agents/skills/` |

Every one of these runs on every pull request. None is path-filtered: a
skipped required check counts as passing, which would let a red job merge.

Shard 1 runs the files listed in the suite's `vitest.integration.config.ts`;
shard 2 runs every other file. `scripts/gates/check-integration-shards.sh`
(in the Lint job) fails the PR if a file is in no shard or in both.

`Build` is not required. It `needs:` the others, so a failed sibling skips it,
and a skipped required check passes. Require each name above instead.

`Publish packages` in `release.yml` runs only on a `v*` tag. It is not a pull-request check; do not add it to `required-checks.txt` or the ruleset.

`Ship loop` in `ship-loop.yml` checks the agent ship-loop section of the pull request body. It is a separate workflow so that it re-runs when the body is edited. It is not a required check unless the CTO adds it to the ruleset; `scripts/gates/check-required-ci-jobs.sh` reads `ci.yml` only, so it is not in `required-checks.txt`.

## Branch protection

`main` needs a ruleset that requires the six names above, requires a pull
request, and blocks force pushes. Set it in the repository settings; this
file and the gate keep the names honest, they do not create the ruleset.
