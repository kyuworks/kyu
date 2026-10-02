#!/usr/bin/env bash
# Unit tests for scan-destructive.sh.
# Run: bash scripts/hooks/scan-destructive.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
SCAN="${SCRIPT_DIR}/scan-destructive.sh"

# About 1.3 MB after the first line: more than a pipe holds, and more than one
# argument may carry (128 KiB on Linux, 1 MiB in total on macOS).
LARGE_PADDING="$(seq -f 'echo padding line %05g with ordinary words' 1 30000)"

# The payload goes to jq on stdin: a large command cannot be an argument.
bash_call() {
  printf '%s' "$1" | jq -Rsc '{tool_name:"Bash",tool_input:{command:.}}'
}

# "empty" when the screen printed nothing, which the caller reads as no objection.
decision() {
  local out
  out="$(printf '%s' "$1" | bash "${SCAN}")"
  [ -n "${out}" ] || { printf 'empty'; return 0; }
  printf '%s' "${out}" | jq -r '.hookSpecificOutput.permissionDecision // "pass"'
}

echo "=== scan-destructive tests ==="

assert_eq "a recursive delete asks" "ask" \
  "$(decision "$(bash_call 'rm -rf /some/path')")"
assert_eq "a plain command passes" "pass" \
  "$(decision "$(bash_call 'ls -la')")"
assert_eq "a database mutation through psql asks" "ask" \
  "$(decision "$(bash_call 'psql "$DATABASE_URL" -c "DELETE FROM contacts"')")"
assert_eq "reading a file that contains DDL words passes" "pass" \
  "$(decision "$(bash_call 'grep -n "DROP TABLE" packages/sdk/migrations/x.sql')")"

assert_eq "a recursive delete inside a command of about 1.3 MB still asks" "ask" \
  "$(decision "$(bash_call "rm -rf /some/path
${LARGE_PADDING}")")"
assert_eq "a psql mutation inside a command of about 1.3 MB still asks" "ask" \
  "$(decision "$(bash_call "psql \"\$DATABASE_URL\" -c \"DELETE FROM contacts\"
${LARGE_PADDING}")")"
assert_eq "a large command with nothing destructive in it passes" "pass" \
  "$(decision "$(bash_call "ls -la
${LARGE_PADDING}")")"

gate_test_finish
