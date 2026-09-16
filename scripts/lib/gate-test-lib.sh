#!/usr/bin/env bash
# Shared helpers for scripts/gates/*.test.sh (manual-only suites).
# Source this file from a test script — do not execute it directly.
#
# Callers mix `set -e` and `set +e`. Capture must restore the caller's
# errexit flag from $-; a blanket `set -e` after the command would turn
# errexit on for suites that started without it.

GATE_TEST_PASS=0
GATE_TEST_FAIL=0
# Compat with suites that still print or bump PASS / FAILED themselves.
PASS=0
FAILED=0
GATE_TEST_LAST_OUT=""
GATE_TEST_LAST_RC=0

_gate_test_mark_pass() {
  local desc="$1"
  GATE_TEST_PASS=$((GATE_TEST_PASS + 1))
  PASS="${GATE_TEST_PASS}"
  echo "PASS: ${desc}"
}

_gate_test_mark_fail() {
  local desc="$1"
  GATE_TEST_FAIL=$((GATE_TEST_FAIL + 1))
  FAILED=1
  echo "FAIL: ${desc}"
}

_gate_test_dump() {
  echo "----- output -----"
  printf '%s\n' "$1"
  echo "------------------"
}

# Run remaining args, capture stdout+stderr and rc, restore errexit.
_gate_test_capture() {
  local saved
  saved=$-
  set +e
  GATE_TEST_LAST_OUT="$("$@" 2>&1)"
  GATE_TEST_LAST_RC=$?
  case "${saved}" in
    *e*) set -e ;;
    *) set +e ;;
  esac
}

# gate_test_record desc ok — ok is 0 for pass, nonzero for fail.
gate_test_record() {
  local desc="$1" ok="$2"
  if [ "${ok}" -eq 0 ]; then
    _gate_test_mark_pass "${desc}"
  else
    _gate_test_mark_fail "${desc}"
  fi
}

# assert_exit desc expected command...
# expected is 0, 1, or the token "nonzero".
assert_exit() {
  local desc="$1" expected="$2"
  shift 2
  if [ "$#" -eq 0 ]; then
    _gate_test_mark_fail "${desc} — assert_exit needs a command"
    return
  fi
  _gate_test_capture "$@"
  local rc="${GATE_TEST_LAST_RC}"
  local matched=0
  if [ "${expected}" = "nonzero" ]; then
    if [ "${rc}" -ne 0 ]; then
      matched=1
    fi
  elif [ "${rc}" -eq "${expected}" ]; then
    matched=1
  fi
  if [ "${matched}" -eq 1 ]; then
    _gate_test_mark_pass "${desc} (exit ${rc})"
    return
  fi
  if [ "${expected}" = "nonzero" ]; then
    _gate_test_mark_fail "${desc} — expected nonzero, got ${rc}"
  else
    _gate_test_mark_fail "${desc} — expected exit ${expected}, got ${rc}"
  fi
  _gate_test_dump "${GATE_TEST_LAST_OUT}"
}

# assert_last_output_contains desc needle
# Uses GATE_TEST_LAST_OUT from the previous capture. Does not re-run.
assert_last_output_contains() {
  local desc="$1" needle="$2"
  if [[ "${GATE_TEST_LAST_OUT}" == *"${needle}"* ]]; then
    _gate_test_mark_pass "${desc}"
    return
  fi
  _gate_test_mark_fail "${desc} — missing [${needle}] (exit ${GATE_TEST_LAST_RC})"
  _gate_test_dump "${GATE_TEST_LAST_OUT}"
}

# assert_output_contains desc needle command...
assert_output_contains() {
  local desc="$1" needle="$2"
  shift 2
  if [ "$#" -eq 0 ]; then
    _gate_test_mark_fail "${desc} — assert_output_contains needs a command"
    return
  fi
  _gate_test_capture "$@"
  # grep -q closes the pipe on the first match. Under pipefail that SIGPIPEs
  # printf and fails a suite whose output did contain the needle.
  if [[ "${GATE_TEST_LAST_OUT}" == *"${needle}"* ]]; then
    _gate_test_mark_pass "${desc}"
    return
  fi
  _gate_test_mark_fail "${desc} — missing [${needle}] (exit ${GATE_TEST_LAST_RC})"
  _gate_test_dump "${GATE_TEST_LAST_OUT}"
}

# assert_output_lacks desc needle command...
assert_output_lacks() {
  local desc="$1" needle="$2"
  shift 2
  if [ "$#" -eq 0 ]; then
    _gate_test_mark_fail "${desc} — assert_output_lacks needs a command"
    return
  fi
  _gate_test_capture "$@"
  if [[ "${GATE_TEST_LAST_OUT}" == *"${needle}"* ]]; then
    _gate_test_mark_fail "${desc} — found [${needle}] (exit ${GATE_TEST_LAST_RC})"
    _gate_test_dump "${GATE_TEST_LAST_OUT}"
    return
  fi
  _gate_test_mark_pass "${desc}"
}

# assert_same desc file_a file_b
assert_same() {
  local desc="$1" a="$2" b="$3"
  if cmp -s "${a}" "${b}"; then
    _gate_test_mark_pass "${desc}"
  else
    _gate_test_mark_fail "${desc}"
  fi
}

# assert_eq desc expected actual
assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "${expected}" = "${actual}" ]; then
    _gate_test_mark_pass "${desc}"
  else
    _gate_test_mark_fail "${desc}"
    echo "  expected: [${expected}]"
    echo "  actual:   [${actual}]"
  fi
}

# assert_neq desc left right
assert_neq() {
  local desc="$1" left="$2" right="$3"
  if [ "${left}" != "${right}" ]; then
    _gate_test_mark_pass "${desc}"
  else
    _gate_test_mark_fail "${desc} — both sides are ${left}"
  fi
}

gate_test_finish() {
  echo ""
  echo "Passed: ${GATE_TEST_PASS}  Failed: ${GATE_TEST_FAIL}"
  if [ "${GATE_TEST_FAIL}" -gt 0 ] || [ "${FAILED}" -ne 0 ]; then
    echo "TESTS FAILED"
    exit 1
  fi
  echo "ALL TESTS PASSED"
  exit 0
}
