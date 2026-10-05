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

assert_exit "the repository's workflows pass" 0 run_real
assert_last_output_contains "the release job is checked" "release.yml publish"

rm -rf "${WF_DIR}"
mkdir -p "${WF_DIR}"
grep -v 'cache-mode: none' "${ROOT_DIR}/.github/workflows/release.yml" > "${WF_DIR}/release.yml"
assert_exit "the real release.yml without cache-mode: none is rejected" 1 run_check
grep -v "cache: 'false'" "${ROOT_DIR}/.github/workflows/release.yml" > "${WF_DIR}/release.yml"
assert_exit "the real release.yml without cache: 'false' is rejected" 1 run_check

gate_test_finish
