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

WF="${TMP}/ci.yml"
REQ="${TMP}/required-checks.txt"

run_check() {
  CI_WORKFLOW="${WF}" REQUIRED_CHECKS="${REQ}" bash "${CHECK}"
}

write_workflow() {
  cat > "${WF}" <<'EOF'
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
EOF
}

write_required() {
  cat > "${REQ}" <<'EOF'
Migration Check
Type Check
EOF
}

echo "=== check-required-ci-jobs tests ==="

# --- Matching fixture lists ---
write_workflow
write_required
assert_exit "matching fixture lists are accepted" 0 run_check
assert_output_contains "matching lists print success" "Required job names are present in ci.yml." \
  env CI_WORKFLOW="${WF}" REQUIRED_CHECKS="${REQ}" bash "${CHECK}"

# --- Required name not in workflow ---
write_workflow
cat > "${REQ}" <<'EOF'
Migration Check
Type Check
Build
EOF
assert_exit "required name missing from workflow is rejected" 1 run_check
assert_output_contains "missing required name is reported" "Build" \
  env CI_WORKFLOW="${WF}" REQUIRED_CHECKS="${REQ}" bash "${CHECK}"

# --- Extra workflow jobs are allowed (main-only exhaustive suites) ---
write_workflow
cat > "${REQ}" <<'EOF'
Migration Check
EOF
assert_exit "extra workflow job is allowed" 0 run_check

# --- Missing required file ---
write_workflow
rm -f "${REQ}"
assert_exit "missing required file is rejected" 1 \
  env CI_WORKFLOW="${WF}" REQUIRED_CHECKS="${REQ}" bash "${CHECK}"

# --- Empty required list after comments ---
write_workflow
cat > "${REQ}" <<'EOF'
# nothing required

EOF
assert_exit "empty required list after comments is rejected" 1 run_check

# --- Comments / blank lines in required list are ignored ---
write_workflow
cat > "${REQ}" <<'EOF'
# Canonical required checks

Migration Check

# trailing comment
Type Check

EOF
assert_exit "comments and blank lines in required list are ignored" 0 run_check

# --- Job without name: uses the job id ---
cat > "${WF}" <<'EOF'
name: CI
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
EOF
cat > "${REQ}" <<'EOF'
bare-job
Named Job
EOF
assert_exit "job without name: uses the job id" 0 run_check

# --- Real repo files (no env override) ---
REAL_REQ="${ROOT_DIR}/.github/workflows/required-checks.txt"
if [ -f "${REAL_REQ}" ]; then
  assert_exit "real repo required-checks.txt names exist in ci.yml" 0 \
    bash "${CHECK}"
else
  echo "SKIP: .github/workflows/required-checks.txt not present yet (docs agent racing)"
fi

gate_test_finish
