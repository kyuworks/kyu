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
| `test-integration` | Integration Tests | Hatchet Lite + Postgres service containers, a worker token minted in the job, then `pnpm test:integration` |
| `self-tests` | Gate Self Tests | `scripts/verify-self-tests.sh` — every `*.test.sh` under `scripts/` and `.agents/skills/` |

Every one of these runs on every pull request. None is path-filtered: a
skipped required check counts as passing, which would let a red job merge.

`Build` is not required. It `needs:` the others, so a failed sibling skips it,
and a skipped required check passes. Require each name above instead.

## Branch protection

`main` needs a ruleset that requires the five names above, requires a pull
request, and blocks force pushes. Set it in the repository settings; this
file and the gate keep the names honest, they do not create the ruleset.
