# Required CI checks

Status-check names that must pass on a pull request into `main`. Machine
list: [`required-checks.txt`](./required-checks.txt). Hosted Actions is the
exhaustive gate; the Husky pre-commit hook is the local quick loop.

GitHub matches the job `name:` string, not the job id. Renaming a `name:`
unhooks branch protection until an admin updates the ruleset **and** this
list. `scripts/gates/check-required-ci-jobs.sh` (in the Lint job) fails the
PR if `required-checks.txt` names a check that is not a job in a workflow that
runs on `pull_request` (`ci.yml` and `ship-loop.yml` today). `release.yml` runs
on tags and does not count.

| Job id | Check name | What it runs |
| --- | --- | --- |
| `lint` | Lint | `pnpm format:check`, `scripts/verify-gates.sh --range <base>...HEAD`, `pnpm lint` |
| `typecheck` | Type Check | `pnpm typecheck`, `pnpm typecheck:tests` |
| `test-unit` | Unit Tests | `pnpm test` (every package's vitest unit suite) |
| `test-integration-sdk-1`, `test-integration-sdk-2` | Integration Tests (1/2), Integration Tests (2/2) | Each: its own Hatchet Lite, Postgres and PgBouncer service containers, a worker token minted in the job, then `pnpm --filter @kyuworks/sdk test:integration` with `KYU_INTEGRATION_SHARD` 1 or 2 |
| `self-tests` | Gate Self Tests | `scripts/verify-self-tests.sh` — every `*.test.sh` under `scripts/` and `.agents/skills/` |
| `ship-loop` (in `ship-loop.yml`) | Ship loop | `scripts/gates/check-agent-ship-loop.sh` on the pull request body |

Every one of these runs on every pull request. None is path-filtered: a
skipped required check counts as passing, which would let a red job merge.

Shard 1 runs the files listed in the suite's `vitest.integration.config.ts`;
shard 2 runs every other file. `scripts/gates/check-integration-shards.sh`
(in the Lint job) fails the PR if a file is in no shard or in both.

Both integration jobs, and `newest-client.yml`, run the `hatchet-lite` tag that
`infra/hatchet/compose.yaml` pins by default, the same tag as
`infra/hatchet/fly/fly.toml`, never `latest`. An engine upgrade changes that one
tag in all four files in one pull request.
`scripts/gates/check-engine-image-tag.sh` (in the Lint job, and in the commit
hook when compose.yaml or fly.toml changes) reads every non-comment line under
`.github/` (workflows and actions) that names `/hatchet-lite`, in any layout,
including `run:` text. It fails the PR and names each file whose tag differs
from compose.yaml; it also fails `latest`, an image with no tag, a file that
names two tags, and a line whose tag it cannot read. Each run's "Wait for the
engine" step prints the engine's version.

`Build` is not required. It `needs:` the others, so a failed sibling skips it,
and a skipped required check passes. Require each name above instead.

`Publish packages` in `release.yml` runs only on a `v*` tag. It is not a pull-request check; do not add it to `required-checks.txt` or the ruleset.

`Newest Hatchet client` in `newest-client.yml` runs every Monday at 06:41 UTC and by hand. It is not a pull-request check; do not add it to `required-checks.txt` or the ruleset. `scripts/newest-hatchet-client.sh` finds the newest stable `@hatchet-dev/typescript-sdk` inside the range in `packages/sdk/package.json`. If that is the lockfile's version, the run stops, green. Otherwise, in its own checkout only, it adds a pnpm override for that version and sets `minimumReleaseAge: 0` (the new client and its new dependencies are younger than seven days), then builds and runs the unit tests and both integration shards against the same services as CI. Nothing is committed. The workflow sets `cache-mode: none`, so the week-young code it runs cannot read or write the repository's cache. A red run means the published range admits a client version the SDK fails on: fix the SDK, or narrow the range in the next release. GitHub emails a failed scheduled run only to whoever last changed its `cron` line.

`Ship loop` in `ship-loop.yml` checks the agent ship-loop section of the pull request body. It is a separate workflow so that it re-runs when the body is edited.

## Branch protection

`main` needs a ruleset that requires the seven names above, requires a pull
request, and blocks force pushes. Set it in the repository settings; this
file and the gate keep the names honest, they do not create the ruleset.

## Release job and the Actions cache

`Publish packages` holds `id-token: write`, which npm trusts to publish. It never restores or saves the Actions cache: the job sets `cache-mode: none` and passes `cache: 'false'` to `.github/actions/setup`, so it installs fresh from the lockfile with the seven-day release-age check. Any job that runs on `main` from `push`, `schedule` or `workflow_dispatch` can write a cache entry that a tag run restores, and `pnpm install --frozen-lockfile` does not re-check files in a restored `node_modules`. A workflow that changes `minimumReleaseAge` sets a top-level `cache-mode: none`, so code younger than seven days never gets a token that can write the cache. The CI jobs above keep the cache; a bad entry there can cause a wrong green or red, not a publish.

`scripts/gates/check-oidc-jobs-skip-cache.sh` (in the Lint job) fails a job with `id-token: write` that lacks `cache-mode: none`, uses the setup action without `cache: 'false'`, uses `actions/cache` directly, or calls a reusable workflow, and fails a workflow that changes `minimumReleaseAge` without a top-level `cache-mode: none`. It reads every workflow and every `action.yml` under `.github/actions/` with the `yaml` package and resolves anchors and aliases. It fails a file that GitHub could read differently: one that does not parse, has more than one document, repeats a key, or uses a merge key, a tag or a directive. It also fails a workflow file whose extension is upper-case, such as `.YML`. An action that changes the release-age rule fails, because an action cannot set `cache-mode`.
