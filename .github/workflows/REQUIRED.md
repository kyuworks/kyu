# Required CI checks

Status-check names that must pass on a pull request into `main`. Machine
list: [`required-checks.txt`](./required-checks.txt). Hosted Actions is the
exhaustive gate; the Husky pre-commit hook is the local quick loop.

GitHub matches the job `name:` string, not the job id. Renaming a `name:`
unhooks branch protection until an admin updates the ruleset **and** this
list. `scripts/gates/check-required-ci-jobs.sh` (in the Lint job) fails the
PR if `required-checks.txt` names a check that is not the `name:` (else the job
id) of a job in a workflow that runs on `pull_request` (`ci.yml` and
`ship-loop.yml` today). It reads each workflow with the `yaml` package and fails
one it cannot read. A matrix job, a job that calls a reusable workflow, or a job whose
`name:` holds `${{` does not count: GitHub builds its check names at run time. `release.yml` runs on tags
and does not count.

The same gate fails when a required name is the check name of more than one job in any workflow; when the job that supplies it has `if:`, `needs:` or `continue-on-error:`, or one of its steps has `continue-on-error:` (a step with it lets the job pass when the step fails); or when its workflow's `pull_request` trigger holds `branches`, `branches-ignore`, `paths`, `paths-ignore` or any key but `types`, or a `types` without `opened`, `synchronize` and `reopened`. The one-job rule covers literal names: a job whose `name:` is an expression, or that has a matrix, is not counted, so a second job that builds the same name at run time is not caught. GitHub reports a job skipped by a condition, or by a failed job it needs, as passing; a workflow its trigger leaves out keeps the check pending and blocks every merge.

| Job id | Check name | What it runs |
| --- | --- | --- |
| `lint` | Lint | `pnpm format:check`, `scripts/verify-gates.sh --range <base>...HEAD`, `pnpm lint` |
| `typecheck` | Type Check | `pnpm typecheck`, `pnpm typecheck:tests` |
| `test-unit` | Unit Tests | `pnpm test` (every package's vitest unit suite) |
| `test-integration-sdk-1`, `test-integration-sdk-2` | Integration Tests (1/2), Integration Tests (2/2) | Each: its own Hatchet Lite, Postgres and PgBouncer service containers, a worker token minted in the job, then `pnpm --filter @kyuworks/sdk test:integration` with `KYU_INTEGRATION_SHARD` 1 or 2 |
| `self-tests` | Gate Self Tests | `scripts/verify-self-tests.sh` — every `*.test.sh` under `scripts/` and `.agents/skills/` |
| `ship-loop` (in `ship-loop.yml`) | Ship loop | `scripts/gates/check-agent-ship-loop.sh` on the pull request body |

Every one of these runs on every pull request: none has a condition, none waits on another job, and no trigger filter can leave one out. `ship-loop.yml` adds `edited` to the three default types so it re-runs when the body changes.

Shard 1 runs the files listed in the suite's `vitest.integration.config.ts`;
shard 2 runs every other file. `scripts/gates/check-integration-shards.sh`
(in the Lint job) fails the PR if a file is in no shard or in both.

Both integration jobs, and `newest-client.yml`, run the `hatchet-lite` tag that
`infra/hatchet/compose.yaml` pins by default, the same tag as
`infra/hatchet/fly/fly.toml`, never `latest`. An engine upgrade changes that one
tag in all four files in one pull request. `newest-engine.yml` is the one exception: it
runs the newest release, picked at run time (below).
`scripts/gates/check-engine-image-tag.sh` (in the Lint job, and in the commit
hook when compose.yaml or fly.toml changes) reads compose.yaml and every YAML
file under `.github/` (workflows and actions) with the `yaml` package and checks
every string that names `/hatchet-lite`, in any layout, including `run:` text.
It fails a file it cannot read, and it fails the PR and names each file whose
tag differs from compose.yaml; it also fails `latest`, an image with no tag, a
file that names two tags, and a reference whose tag it cannot read. Every
reference, compose.yaml's included, must also sit at the registry path
`ghcr.io/hatchet-dev/hatchet` exactly (`ENGINE_PATH` in
`check-engine-image-tag.mjs`), so moving the engine to another registry is a
deliberate edit to the gate; under `.github/` the path is the text after the last
space or line break, less one opening quote and one `docker://`. Its only
exemption is the tag `${{ needs.pick.outputs.tag }}` in `newest-engine.yml`, whose
registry path is still checked; that expression anywhere else, any other expression
there, or a literal tag there that differs from compose.yaml still fails. It also fails a digest after a tag (Docker pulls by the
digest, so the tag is not what runs), and `hatchet-lite:<tag>` or `hatchet-lite@<digest>` written with
no registry path before the name or in upper case. A name that merely ends in `hatchet-lite`, and
`hatchet-lite:<port>` with no registry path (a host and port), are not references. `fly.toml` names
the engine once, on the line after `[build]`, as `image = '<registry>/hatchet-lite:<tag>'`; `[build]`
holds only `image`; outside whole-line comments no other line names `build`, `image` or `hatchet-lite`,
or holds an escape or a multi-line string. On a line that names one of them or holds a backslash,
`'''` or `"""`, `[build]` and the image line included, a comment must be on its own line; other
lines may carry a trailing comment, such as `primary_region = 'syd' # region`. Each run's "Wait for the
engine" step prints the engine's version.

`Build` is not required. It `needs:` the others, so a failed sibling skips it,
and a skipped required check passes. Require each name above instead.

`Publish packages` in `release.yml` runs only on a `v*` tag. It is not a pull-request check; do not add it to `required-checks.txt` or the ruleset.

`Newest Hatchet client` in `newest-client.yml` runs every Monday at 06:41 UTC and by hand. It is not a pull-request check; do not add it to `required-checks.txt` or the ruleset. `scripts/newest-hatchet-client.sh` finds the newest stable `@hatchet-dev/typescript-sdk` inside the range in `packages/sdk/package.json`. If that is the lockfile's version, the run stops, green. Otherwise, in its own checkout only, it adds a pnpm override for that version and sets `minimumReleaseAge: 0` (the new client and its new dependencies are younger than seven days), then builds and runs the unit tests and both integration shards against the same services as CI. Nothing is committed. The workflow sets `cache-mode: none`, so the week-young code it runs cannot read or write the repository's cache. A red run means the published range admits a client version the SDK fails on: fix the SDK, or narrow the range in the next release. GitHub emails a failed scheduled run only to whoever last changed its `cron` line.

`Newest Hatchet engine` in `newest-engine.yml` runs every Wednesday at 07:23 UTC and by hand. It is not a pull-request check; do not add it to `required-checks.txt` or the ruleset. `scripts/newest-hatchet-engine.sh` lists the `hatchet-lite` tags in the GitHub container registry without credentials and picks the highest plain `vX.Y.Z` whose image manifest exists (a listed release tag with no pullable image is skipped). If that is the tag `infra/hatchet/compose.yaml` pins, the run stops, green; the `force` input runs it anyway. Otherwise it runs the unit tests and both integration shards against that engine, with the same services as CI. It has read-only permissions, no secrets, `cache-mode: none`, and changes nothing in the repository. A red run is a signal to read before an engine upgrade, not a failed pull request. GitHub emails a failed scheduled run only to whoever last changed its `cron` line.

`Ship loop` in `ship-loop.yml` checks the agent ship-loop section of the pull request body. It is a separate workflow so that it re-runs when the body is edited.

## Branch protection

`main` needs a ruleset that requires the seven names above, requires a pull
request, and blocks force pushes. Set it in the repository settings; this
file and the gate keep the names honest, they do not create the ruleset.

## Release job and the Actions cache

`Publish packages` holds `id-token: write`, which npm trusts to publish. It never restores or saves the Actions cache: the job sets `cache-mode: none` and passes `cache: 'false'` to `.github/actions/setup`, so it installs fresh from the lockfile with the seven-day release-age check. Any job that runs on `main` from `push`, `schedule` or `workflow_dispatch` can write a cache entry that a tag run restores, and `pnpm install --frozen-lockfile` does not re-check files in a restored `node_modules`. A workflow that changes `minimumReleaseAge` sets a top-level `cache-mode: none`, so code younger than seven days never gets a token that can write the cache. The CI jobs above keep the cache; a bad entry there can cause a wrong green or red, not a publish.

`scripts/gates/check-oidc-jobs-skip-cache.sh` (in the Lint job) fails a job with `id-token: write` that lacks `cache-mode: none`, uses the setup action without `cache: 'false'`, uses `actions/cache` directly, or calls a reusable workflow, and fails a workflow that changes `minimumReleaseAge` without a top-level `cache-mode: none`. It reads every workflow and every `action.yml` under `.github/actions/` with the `yaml` package and resolves anchors and aliases. It fails a file that GitHub could read differently: one that does not parse, has more than one document, repeats a key, or uses a merge key, a tag or a directive. It also fails a workflow file whose extension is upper-case, such as `.YML`. An action that changes the release-age rule fails, because an action cannot set `cache-mode`.
