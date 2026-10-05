#!/usr/bin/env bash
# Unit tests for check-oidc-jobs-skip-cache.sh.
# Run: bash scripts/gates/check-oidc-jobs-skip-cache.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${ROOT_DIR}/scripts/lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-oidc-jobs-skip-cache.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
WF_DIR="${TMP}/workflows"

run_check() {
  CI_WORKFLOWS_DIR="${WF_DIR}" bash "${CHECK}"
}

run_real() {
  CI_WORKFLOWS_DIR="${ROOT_DIR}/.github/workflows" bash "${CHECK}"
}

# publish_workflow <job-level lines> <setup with: lines>
publish_workflow() {
  rm -rf "${WF_DIR}"
  mkdir -p "${WF_DIR}"
  {
    printf 'name: Release\non:\n  push:\n    tags: [%sv*%s]\npermissions:\n  contents: read\njobs:\n  publish:\n    name: Publish packages\n    runs-on: ubuntu-latest\n' "'" "'"
    printf '%s' "$1"
    printf '    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - uses: actions/checkout@v5\n      - uses: ./.github/actions/setup\n        with:\n          build: %strue%s\n' "'" "'"
    printf '%s' "$2"
    printf '      - name: Publish\n        run: pnpm -r publish\n'
  } > "${WF_DIR}/release.yml"
}

NONE=$'    cache-mode: none\n'
NO_CACHE=$'          cache: \'false\'\n'

echo "=== check-oidc-jobs-skip-cache tests ==="

publish_workflow "${NONE}" ""
assert_exit "id-token job using the setup action without cache: 'false' is rejected" 1 run_check
assert_last_output_contains "the setup step is named" "uses ./.github/actions/setup without cache: 'false'"

publish_workflow "${NONE}" "${NO_CACHE}"
assert_exit "id-token job with cache-mode: none and cache: 'false' is accepted" 0 run_check
assert_last_output_contains "the job is listed as checked" "release.yml publish"

publish_workflow "    cache-mode: 'none'"$'\n' '          cache: "false"'$'\n'
assert_exit "quoted cache-mode and cache values are accepted" 0 run_check

publish_workflow "" "${NO_CACHE}"
assert_exit "id-token job without cache-mode: none is rejected" 1 run_check
assert_last_output_contains "the missing cache-mode is named" "does not set cache-mode: none"

publish_workflow "    cache-mode: read"$'\n' "${NO_CACHE}"
assert_exit "id-token job with cache-mode: read is rejected" 1 run_check

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
      - uses: actions/cache/restore@v4
        with:
          path: node_modules
          key: nm
YAML
assert_exit "id-token job calling actions/cache directly is rejected" 1 run_check
assert_last_output_contains "the direct cache step is named" "uses actions/cache directly"

rm -rf "${WF_DIR}"
mkdir -p "${WF_DIR}"
cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  test-unit:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/setup
      - uses: actions/cache@v4
        with:
          path: x
          key: x
YAML
assert_exit "a job without id-token that uses the cache is accepted" 0 run_check

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
permissions:
  contents: read
  id-token: write
jobs:
  inherits:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/setup
  overrides:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: ./.github/actions/setup
YAML
assert_exit "a workflow-level id-token: write reaches a job with no permissions of its own" 1 run_check
assert_last_output_contains "the inheriting job is named" "ci.yml job inherits has id-token: write"
assert_output_lacks "a job that sets its own permissions without id-token is not checked" "ci.yml overrides" run_check

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
jobs:
  everything:
    runs-on: ubuntu-latest
    permissions: write-all
    steps:
      - run: echo hi
YAML
assert_exit "permissions: write-all counts as id-token: write" 1 run_check

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Newest client
on: schedule
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: sed -i 's/^minimumReleaseAge: .*/minimumReleaseAge: 0/' pnpm-workspace.yaml
YAML
assert_exit "a workflow that changes minimumReleaseAge without top-level cache-mode: none is rejected" 1 run_check
printf 'cache-mode: none\n' >> "${WF_DIR}/ci.yml"
assert_exit "a workflow that changes minimumReleaseAge with top-level cache-mode: none is accepted" 0 run_check

# Layouts the scanner cannot read must fail closed, not pass with no job checked.
UNREADABLE="could not find the job"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions: {id-token: write, contents: read}
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "a job-level flow-map permissions with id-token: write is rejected" 1 run_check
assert_last_output_contains "the unreadable flow map is named" "${UNREADABLE}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
permissions: {id-token: write, contents: read}
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "a workflow-level flow-map permissions with id-token: write is rejected" 1 run_check
assert_last_output_contains "the unreadable workflow flow map is named" "${UNREADABLE}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
jobs:
    publish:
        runs-on: ubuntu-latest
        permissions:
            id-token: write
        steps:
            - uses: actions/cache@v4
YAML
assert_exit "jobs indented four spaces with id-token: write are rejected" 1 run_check
assert_last_output_contains "the unreadable indentation is named" "${UNREADABLE}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
permissions:
    id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "a four-space workflow-level permissions block with id-token: write is rejected" 1 run_check
assert_last_output_contains "the unreadable permissions block is named" "${UNREADABLE}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
permissions:
  id-token: write
jobs:
  readable:
    runs-on: ubuntu-latest
    cache-mode: none
    steps:
      - run: echo hi
  odd:
    runs-on: ubuntu-latest
    permissions: {id-token: write}
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "one readable id-token job does not excuse an unreadable one" 1 run_check
assert_last_output_contains "the unreadable job is named" "${UNREADABLE}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token : write
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "id-token with a space before the colon at job level is still an OIDC job" 1 run_check
assert_last_output_contains "the spaced job-level grant is read" "ci.yml job publish has id-token: write"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
permissions :
  id-token : write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "id-token with a space before the colon at workflow level is still an OIDC job" 1 run_check
assert_last_output_contains "the spaced workflow-level grant is read" "ci.yml job publish has id-token: write"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
permissions:
  id-token: write
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: echo hi
YAML
assert_exit "workflow-level id-token where every job overrides permissions without it passes" 0 run_check

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
permissions:
  id-token: write
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: echo hi
  publish: {runs-on: ubuntu-latest, steps: [{uses: actions/cache@v4}]}
YAML
assert_exit "workflow-level id-token with a job the gate cannot read is still rejected" 1 run_check

# cache-mode inheritance: a top-level value applies unless the job overrides it.
cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
cache-mode: none
permissions:
  contents: read
  id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
YAML
assert_exit "a top-level cache-mode: none covers an id-token job with no cache-mode of its own" 0 run_check
sed -i.bak 's/^    runs-on: ubuntu-latest$/    runs-on: ubuntu-latest\n    cache-mode: write/' "${WF_DIR}/ci.yml" && rm "${WF_DIR}/ci.yml.bak"
assert_exit "a job-level cache-mode: write overrides a top-level cache-mode: none and is rejected" 1 run_check

# Every spelling of relaxing the release-age rule needs a top-level cache-mode: none.
for lift in \
  'run: PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm install' \
  'run: pnpm_config_minimum_release_age=0 pnpm install' \
  'run: pnpm install --config.minimum-release-age=0'; do
  cat > "${WF_DIR}/ci.yml" <<YAML
name: Newest client
on: schedule
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - ${lift}
YAML
  assert_exit "'${lift#run: }' without top-level cache-mode: none is rejected" 1 run_check
  printf 'cache-mode: none\n' >> "${WF_DIR}/ci.yml"
  assert_exit "'${lift#run: }' with top-level cache-mode: none is accepted" 0 run_check
done

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
# minimumReleaseAge stays at seven days; this workflow does not change it.
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
YAML
assert_exit "a column-zero comment that mentions minimumReleaseAge is not a change to the rule" 0 run_check

publish_workflow "${NONE}" $'          cache: ${{ false }}\n'
assert_exit "cache: \${{ false }} is rejected (only the literal 'false' counts)" 1 run_check

# YAML anchors and aliases: the gate does not resolve them, so it fails closed.
ALIASED="puts a YAML anchor, alias or tag on permissions, id-token or cache-mode"
SHARED="can publish and uses a YAML alias or merge key"

rm -rf "${WF_DIR}"
mkdir -p "${WF_DIR}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
x-w: &w write
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: *w
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "an id-token value written as an alias is rejected" 1 run_check
assert_last_output_contains "the aliased id-token is named" "line 9 ${ALIASED}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
x-a: &a write-all
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions: *a
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "a permissions value written as an alias is rejected" 1 run_check
assert_last_output_contains "the aliased permissions is named" "line 7 ${ALIASED}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
x-m: &m write
cache-mode: *m
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
YAML
assert_exit "a cache-mode value written as an alias is rejected" 1 run_check
assert_last_output_contains "the aliased cache-mode is named" "line 4 ${ALIASED}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    permissions: &p
      contents: read
    steps:
      - run: echo hi
  b:
    runs-on: ubuntu-latest
    permissions:
      <<: *p
    steps:
      - run: echo hi
YAML
assert_exit "an anchored permissions block, and a merge key inside one, are rejected" 1 run_check
assert_last_output_contains "the anchored permissions is named" "line 6 ${ALIASED}"
assert_last_output_contains "the merge key inside permissions is named" "line 13 ${ALIASED}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      *p
    steps:
      - run: echo hi
YAML
assert_exit "a permissions alias on the line below the key is rejected" 1 run_check
assert_last_output_contains "the next-line alias is named" "line 7 ${ALIASED}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on: push
x-p: &p
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    permissions: *p
    steps:
      - run: echo hi
YAML
assert_exit "a permissions alias is rejected even in a workflow with no publishing job" 1 run_check

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: !!str write
    steps:
      - uses: actions/cache@v4
YAML
assert_exit "an id-token value with a YAML tag is rejected" 1 run_check
assert_last_output_contains "the tagged id-token is named" "line 7 ${ALIASED}"

cat > "${WF_DIR}/ci.yml" <<'YAML'
name: Release
on: push
jobs:
  publish: {runs-on: ubuntu-latest, permissions: *a, steps: [{uses: actions/cache@v4}]}
YAML
assert_exit "a permissions alias inside a flow-map job is rejected" 1 run_check
assert_last_output_contains "the flow-map alias is named" "line 4 ${ALIASED}"

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  other:
    runs-on: ubuntu-latest
    steps: *shared
YAML
assert_exit "a publishing workflow with steps: *shared is rejected" 1 run_check
assert_last_output_contains "the shared steps are named" "${SHARED} at line 25"

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  other:
    <<: *base
    runs-on: ubuntu-latest
YAML
assert_exit "a publishing workflow with a <<: *base job is rejected" 1 run_check
assert_last_output_contains "the merge key is named" "${SHARED} at line 24"

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  other:
    runs-on: ubuntu-latest
    steps: [*s]
YAML
assert_exit "a publishing workflow with an alias inside a flow sequence is rejected" 1 run_check

rm -rf "${WF_DIR}"
mkdir -p "${WF_DIR}"
cat > "${WF_DIR}/ci.yml" <<'YAML'
name: CI
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  one:
    runs-on: ubuntu-latest
    services: &engine
      postgres:
        image: postgres:15.6
        options: >-
          --health-cmd "pg_isready"
          --health-retries 10
    steps: &shared
      - uses: actions/checkout@v5
      - uses: ./.github/actions/setup
      - run: |
          for i in $(seq 1 3); do curl -fsS x && break; done
  two:
    runs-on: ubuntu-latest
    services: *engine
    steps: *shared
YAML
assert_exit "a workflow with no publishing job may share services and steps through anchors" 0 run_check

publish_workflow "${NONE}" "${NO_CACHE}"
cat >> "${WF_DIR}/release.yml" <<'YAML'
  lookalikes:
    runs-on: ubuntu-latest
    if: ${{ github.event_name == 'push' && true }}
    env:
      CRON: '41 6 * * 1'
      GLOB: "*.ts"
    steps:
      - run: pnpm lint && pnpm test
      - run: ls *.ts
      - run: echo "key: *value" 'flow: [a,*b]'
      - run: |
          make a \
            && make b
          *unusual line in a script
          &another
      - name: Branches
        run: echo done
        env:
          B: ['*', 'a,*b']
YAML
assert_exit "text that only looks like an alias does not trip a publishing workflow" 0 run_check

assert_exit "the repository's workflows pass" 0 run_real
assert_last_output_contains "the release job is checked" "release.yml publish"

rm -rf "${WF_DIR}"
mkdir -p "${WF_DIR}"
grep -v 'cache-mode: none' "${ROOT_DIR}/.github/workflows/release.yml" > "${WF_DIR}/release.yml"
assert_exit "the real release.yml without cache-mode: none is rejected" 1 run_check
grep -v "cache: 'false'" "${ROOT_DIR}/.github/workflows/release.yml" > "${WF_DIR}/release.yml"
assert_exit "the real release.yml without cache: 'false' is rejected" 1 run_check

gate_test_finish
