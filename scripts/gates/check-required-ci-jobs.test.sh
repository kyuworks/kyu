#!/usr/bin/env bash
# Unit tests for check-required-ci-jobs.sh (#282).
# Run: bash scripts/gates/check-required-ci-jobs.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-required-ci-jobs.sh"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

WF_DIR="${TMP}/workflows"
WF="${WF_DIR}/ci.yml"
REQ="${TMP}/required-checks.txt"

run_check() {
  CI_WORKFLOWS_DIR="${WF_DIR}" REQUIRED_CHECKS="${REQ}" bash "${CHECK}"
}

write_workflow() {
  rm -rf "${WF_DIR}"
  mkdir -p "${WF_DIR}"
  cat > "${WF}" <<'YAML'
name: CI

on:
  pull_request:

jobs:
  migration-check:
    name: Migration Check
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v5
      - name: Check timestamps
        run: echo ok

  typecheck:
    name: Type Check
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v5
YAML
}

write_required() {
  cat > "${REQ}" <<'TXT'
Migration Check
Type Check
TXT
}

# write_second_workflow file on-block job-name
write_second_workflow() {
  printf 'name: Second\n\n%s\n\njobs:\n  second:\n    name: %s\n    runs-on: ubuntu-latest\n' \
    "$2" "$3" > "${WF_DIR}/$1"
}

echo "=== check-required-ci-jobs tests ==="

# --- Matching fixture lists ---
write_workflow
write_required
assert_exit "matching fixture lists are accepted" 0 run_check
assert_output_contains "matching lists print success" "Required job names are present in pull-request workflows." \
  run_check

# --- Required name not in workflow ---
write_workflow
cat > "${REQ}" <<'TXT'
Migration Check
Type Check
Build
TXT
assert_exit "required name missing from workflow is rejected" 1 run_check
assert_output_contains "missing required name is reported" "Build" run_check

# --- Extra workflow jobs are allowed (main-only exhaustive suites) ---
write_workflow
cat > "${REQ}" <<'TXT'
Migration Check
TXT
assert_exit "extra workflow job is allowed" 0 run_check

# --- Missing required file ---
write_workflow
rm -f "${REQ}"
assert_exit "missing required file is rejected" 1 run_check

# --- Missing workflows directory ---
write_required
rm -rf "${WF_DIR}"
assert_exit "missing workflows directory is rejected" 1 run_check

# --- Empty required list after comments ---
write_workflow
cat > "${REQ}" <<'TXT'
# nothing required

TXT
assert_exit "empty required list after comments is rejected" 1 run_check

# --- Comments / blank lines in required list are ignored ---
write_workflow
cat > "${REQ}" <<'TXT'
# Canonical required checks

Migration Check

# trailing comment
Type Check

TXT
assert_exit "comments and blank lines in required list are ignored" 0 run_check

# --- Job without name: uses the job id ---
write_workflow
cat > "${WF}" <<'YAML'
name: CI
on:
  pull_request:
jobs:
  bare-job:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v5
  named-job:
    name: Named Job
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v5
YAML
cat > "${REQ}" <<'TXT'
bare-job
Named Job
TXT
assert_exit "job without name: uses the job id" 0 run_check

# --- A name from a second pull-request workflow counts ---
write_workflow
write_second_workflow ship-loop.yml "$(printf 'on:\n  pull_request:\n    types: [opened, edited, synchronize, reopened]')" "Ship loop"
printf 'Migration Check\nType Check\nShip loop\n' > "${REQ}"
assert_exit "required name only in a second pull-request workflow is accepted" 0 run_check

# --- Renaming the job in the second workflow fails the gate ---
write_second_workflow ship-loop.yml "$(printf 'on:\n  pull_request:')" "Ship loop check"
assert_exit "required name renamed in the second pull-request workflow is rejected" 1 run_check
assert_last_output_contains "renamed name is reported" "Ship loop"

# --- List form on: [push, pull_request] counts ---
write_workflow
write_second_workflow extra.yaml "on: [push, pull_request] # list form" "List Form"
printf 'Migration Check\nList Form\n' > "${REQ}"
assert_exit "on: list form with pull_request counts as a pull-request workflow" 0 run_check

# --- A tag-only workflow cannot satisfy a required name ---
write_workflow
write_second_workflow release.yml "$(printf "on:\n  push:\n    tags: ['v*']")" "Publish packages"
printf 'Migration Check\nPublish packages\n' > "${REQ}"
assert_exit "required name only in a tag-only workflow is rejected" 1 run_check
assert_last_output_contains "tag-only name is reported" "Publish packages"

# --- A workflow with no pull_request trigger is ignored ---
write_workflow
write_second_workflow target.yml "on: [push, pull_request_target]" "Target Only"
printf 'Migration Check\nTarget Only\n' > "${REQ}"
assert_exit "workflow with no pull_request trigger is ignored" 1 run_check

# --- A pull_request item nested under another trigger does not count ---
write_workflow
write_second_workflow nested.yml "$(printf 'on:\n  push:\n    branches:\n      - pull_request')" "Nested Item"
printf 'Migration Check\nNested Item\n' > "${REQ}"
assert_exit "a pull_request item under push branches does not count" 1 run_check

# --- A workflow_call input named pull_request does not count ---
write_workflow
write_second_workflow called.yml "$(printf 'on:\n  workflow_call:\n    inputs:\n      pull_request:\n        type: boolean')" "Called Only"
printf 'Migration Check\nCalled Only\n' > "${REQ}"
assert_exit "a workflow_call input named pull_request does not count" 1 run_check

# --- Real repo files (no env override) ---
REAL_REQ="${ROOT_DIR}/.github/workflows/required-checks.txt"
if [ -f "${REAL_REQ}" ]; then
  assert_exit "real repo required-checks.txt names exist in pull-request workflows" 0 \
    bash "${CHECK}"
else
  echo "SKIP: .github/workflows/required-checks.txt not present yet (docs agent racing)"
fi

gate_test_finish
