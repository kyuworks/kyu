#!/usr/bin/env bash
# Tests for scripts/lib/gate-test-lib.sh.
# Run: bash scripts/lib/gate-test-lib.test.sh
#
# Gate self-tests are manual-only (not CI). This file drives the shipped
# helpers against true/false/printf so a future drift in assert_exit is
# loud here instead of in every scripts/gates/*.test.sh copy.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${SCRIPT_DIR}/gate-test-lib.sh"
source "${LIB}"

TEST_TMP=$(mktemp -d)
trap 'rm -rf "${TEST_TMP}"' EXIT

# Inner suites must source a fresh copy so their counters don't collide
# with this file's PASS/FAIL tallies.
run_suite() {
  bash -c '
    set -uo pipefail
    source "$1"
    shift
    eval "$1"
    gate_test_finish
  ' _ "${LIB}" "$1"
}

assert_exit "true exits 0" 0 true
assert_exit "false exits 1" 1 false
assert_exit "false is nonzero" nonzero false
assert_output_contains "printf contains hello" "hello" printf '%s' "hello world"
assert_output_contains "early needle in long stdout still matches" "needle" \
  bash -c 'printf %s needle; dd if=/dev/zero bs=1024 count=256 2>/dev/null | tr "\0" x'

printf 'alpha\n' > "${TEST_TMP}/a.txt"
cp "${TEST_TMP}/a.txt" "${TEST_TMP}/b.txt"
printf 'beta\n' > "${TEST_TMP}/c.txt"
assert_same "identical files match" "${TEST_TMP}/a.txt" "${TEST_TMP}/b.txt"
assert_eq "equal strings match" "x" "x"
assert_neq "different strings differ" "x" "y"

assert_exit "all-pass finish exits 0" 0 run_suite 'assert_exit "inner true" 0 true'
assert_output_contains "all-pass finish names ALL TESTS PASSED" "ALL TESTS PASSED" \
  run_suite 'assert_exit "inner true" 0 true'

assert_exit "mismatched exit fails the suite" 1 \
  run_suite 'assert_exit "true is not 1" 1 true'
assert_output_contains "mismatched exit dumps command output" "----- output -----" \
  run_suite 'assert_exit "true is not 1" 1 true'
assert_exit "true as nonzero fails the suite" 1 \
  run_suite 'assert_exit "true is nonzero" nonzero true'
assert_exit "missing command fails the suite" 1 \
  run_suite 'assert_exit "no command" 0'
assert_exit "assert_same mismatch fails the suite" 1 \
  run_suite "assert_same files-differ \"${TEST_TMP}/a.txt\" \"${TEST_TMP}/c.txt\""
assert_output_contains "missing needle is named" "missing [nope]" \
  run_suite 'assert_output_contains "needle" "nope" printf "%s" "hello"'

assert_output_contains "assert_output_lacks passes when the needle is absent" "PASS: absent" \
  run_suite 'assert_output_lacks "absent" "nope" printf "%s" "hello"'
assert_exit "assert_output_lacks fails the suite when the needle is present" 1 \
  run_suite 'assert_output_lacks "present" "hello" printf "%s" "hello"'
assert_output_contains "found needle is named" "found [hello]" \
  run_suite 'assert_output_lacks "present" "hello" printf "%s" "hello"'

# Restore the caller's errexit flag from $-; do not force set -e on.
# Write the flag to a file — bash 3.2 rejects `case` inside $().
(
  set -e
  source "${LIB}"
  assert_exit "false is 1" 1 false >/dev/null
  case "$-" in
    *e*) printf 'restored-e\n' > "${TEST_TMP}/errexit.txt" ;;
    *) printf 'lost-e\n' > "${TEST_TMP}/errexit.txt" ;;
  esac
)
assert_eq "set -e caller keeps errexit after assert_exit" "restored-e" "$(cat "${TEST_TMP}/errexit.txt")"

(
  set +e
  source "${LIB}"
  assert_exit "false is 1" 1 false >/dev/null
  case "$-" in
    *e*) printf 'gained-e\n' > "${TEST_TMP}/plus-e.txt" ;;
    *) printf 'kept-plus-e\n' > "${TEST_TMP}/plus-e.txt" ;;
  esac
)
assert_eq "set +e caller does not gain errexit after assert_exit" "kept-plus-e" "$(cat "${TEST_TMP}/plus-e.txt")"

# A matching failing command must not abort a set -e caller.
rm -f "${TEST_TMP}/still.txt"
(
  set -e
  source "${LIB}"
  assert_exit "false is 1" 1 false >/dev/null
  printf 'still-running\n' > "${TEST_TMP}/still.txt"
)
assert_eq "set -e caller continues after a matching failure" "still-running" "$(cat "${TEST_TMP}/still.txt")"

gate_test_record "manual pass records" 0
gate_test_finish
