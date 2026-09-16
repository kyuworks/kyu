#!/usr/bin/env bash
# Decide what one RED₂ command run proved. Prints exactly one word on stdout:
#
#   PROVEN          a test runner ran and reported failures
#   FALSE-POSITIVE  the command exited 0
#   NOT-RUN         the command never got as far as running tests
#
# Usage: red2-classify.sh <exit-code> <output-file>
#
# A test runner that runs and fails always says how many tests failed; a
# command that never started says nothing of the sort. That difference is the
# only signal available without knowing which runner is in use, and it is why
# a non-zero exit on its own is not proof — pnpm exiting 1 on a missing script
# looks identical to vitest exiting 1 on forty failed assertions.
#
# The one diagnostic line goes to stderr so stdout stays a single word.

set -uo pipefail

[ $# -eq 2 ] || { echo "usage: red2-classify.sh <exit-code> <output-file>" >&2; exit 2; }
RC="$1"
OUT="$2"
[ -f "$OUT" ] || { echo "red2-classify: no such output file: $OUT" >&2; exit 2; }

# `No such file or directory` is deliberately absent: a test asserting a file
# exists prints it on a genuine failure, and first-match-wins would throw
# that RED away.
MISSING_COMMAND='Command ".*" not found|Missing script|ERR_PNPM_NO_SCRIPT|ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT|command not found'

# Case-sensitive: `FAIL` and `Tests` are runner output; lowercase matches are
# usually prose. The last two are gate-test-lib.sh's summary, so this
# repository's shell suites count as a runner too.
RUNNER_EVIDENCE='Test Files|Tests[[:space:]]+[0-9]|[0-9]+ (passed|failed|skipped)|AssertionError|FAIL[[:space:]]|✕|✗|×|●[[:space:]]|Passed: [0-9]+[[:space:]]+Failed: [0-9]+|TESTS FAILED'

verdict() {
  echo "red2-classify: $2" >&2
  printf '%s\n' "$1"
  exit 0
}

# A wrong --filter exits 0 with "No projects matched the filters". Calling that a
# false positive sends the verify skill off to edit frozen tests.
if [ "$RC" -eq 0 ]; then
  grep -qE "$RUNNER_EVIDENCE" "$OUT" || verdict NOT-RUN "exit 0 — but no test-runner summary in the output, so nothing ran"
  verdict FALSE-POSITIVE "exit 0 — the tests passed"
fi
[ "$RC" -ne 126 ] && [ "$RC" -ne 127 ] || verdict NOT-RUN "exit $RC — the command could not be executed"
! grep -qEi "$MISSING_COMMAND" "$OUT" || verdict NOT-RUN "exit $RC — output names a missing command or script"
grep -qE "$RUNNER_EVIDENCE" "$OUT" || verdict NOT-RUN "exit $RC — no test-runner summary in the output"
verdict PROVEN "exit $RC with a test-runner summary in the output"
