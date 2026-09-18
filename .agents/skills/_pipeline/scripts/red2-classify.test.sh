#!/usr/bin/env bash
# Unit tests for red2-classify.sh.
# Run: bash .agents/skills/_pipeline/scripts/red2-classify.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../../../scripts/lib/gate-test-lib.sh"
CLASSIFY="${SCRIPT_DIR}/red2-classify.sh"

FIXTURES="$(mktemp -d)"
trap 'rm -rf "${FIXTURES}"' EXIT

# fixture name line...
fixture() {
  local name="$1"
  shift
  printf '%s\n' "$@" > "${FIXTURES}/${name}.txt"
}

verdict() {
  bash "${CLASSIFY}" "$1" "${FIXTURES}/$2.txt" 2>/dev/null
}

echo "=== red2-classify tests ==="

fixture vitest-failed "Test Files  3 failed (3)" "     Tests  12 failed"
assert_eq "a vitest run with failures is proven" "PROVEN" \
  "$(verdict 1 vitest-failed)"

fixture vitest-passed "Test Files  3 passed (3)"
assert_eq "exit 0 with a runner summary is a false positive" "FALSE-POSITIVE" \
  "$(verdict 0 vitest-passed)"

fixture no-match "No projects matched the filters in \"/repo\""
assert_eq "exit 0 with no runner summary ran nothing" "NOT-RUN" \
  "$(verdict 0 no-match)"

fixture missing-script "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL" 'Command "test:integration" not found'
assert_eq "a missing pnpm script did not run any test" "NOT-RUN" \
  "$(verdict 1 missing-script)"

# `pnpm --filter <pkg> test` prints ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL whenever
# the script it ran exited non-zero — which is what a failing test suite does.
fixture pnpm-run-first-fail "Test Files  1 failed (1)" "     Tests  2 failed (2)" \
  '[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @qtaxis/sdk@0.0.0 test: `vitest run`' "Exit status 1"
assert_eq "a filtered pnpm run whose tests failed is proven" "PROVEN" \
  "$(verdict 1 pnpm-run-first-fail)"

fixture missing-binary "sh: vitest: command not found"
assert_eq "exit 127 did not run any test" "NOT-RUN" \
  "$(verdict 127 missing-binary)"

: > "${FIXTURES}/empty.txt"
assert_eq "no output at all is not proof" "NOT-RUN" \
  "$(verdict 1 empty)"

# The integration suite needs the local Hatchet stack (infra/hatchet/compose.yaml).
# Hatchet or its Postgres being down is a setup problem, not a RED.
fixture db-down "Error: connect ECONNREFUSED 127.0.0.1:5432"
assert_eq "a database that will not connect is a setup problem, not proof" "NOT-RUN" \
  "$(verdict 1 db-down)"

fixture assertion "AssertionError: expected 3 to equal 4"
assert_eq "an assertion error is runner evidence" "PROVEN" \
  "$(verdict 1 assertion)"

# Guards the decision to leave `No such file or directory` out of the
# missing-command list: a test asserting a file exists prints it on a real RED.
fixture enoent "FAIL src/x.test.ts" "Error: ENOENT: no such file or directory"
assert_eq "a failing suite that mentions a missing file is still proven" "PROVEN" \
  "$(verdict 1 enoent)"

# The first end-to-end RED₂ run in this repository classified its own shell
# suites as NOT-RUN: gate-test-lib.sh's summary matched nothing.
fixture shell-suite "FAIL: a case" "Passed: 0  Failed: 11" "TESTS FAILED"
assert_eq "a gate-test-lib suite with failures is proven" "PROVEN" \
  "$(verdict 1 shell-suite)"

fixture runner-setup "FAIL: no *.test.sh found under /tmp/x"
assert_eq "a runner that found nothing to run is not proof" "NOT-RUN" \
  "$(verdict 1 runner-setup)"

assert_output_contains "the diagnostic goes to stderr and names the rule" "red2-classify:" \
  bash "${CLASSIFY}" 1 "${FIXTURES}/missing-script.txt"
assert_eq "stdout is exactly one word" "1" \
  "$(bash "${CLASSIFY}" 1 "${FIXTURES}/vitest-failed.txt" 2>/dev/null | wc -l | tr -d ' ')"

assert_exit "a missing output file is a usage error" 2 \
  bash "${CLASSIFY}" 1 "${FIXTURES}/does-not-exist.txt"

gate_test_finish
