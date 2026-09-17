#!/usr/bin/env bash
# Unit tests for check.sh's serial window (#review).
# Run: bash scripts/check.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check.sh"
echo "=== check.sh tests ==="

# --- The serial window covers a selected step, not just its bare name ---
#
# scripts/lib/select-changed-checks.mjs emits ids like "lint:packages/sdk",
# not bare "lint". is_serial_prefix must match the prefix before the first
# colon, or a gate-triggered run pushes every lint and typecheck step into
# the parallel group — the exact thing the leading serial window exists to
# prevent (oxlint OOM on the 8 GB sandbox).
#
# lint sleeps, then writes a marker; typecheck checks for the marker. If the
# two ran in parallel, typecheck would very likely run first and fail.
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
MARKER="${TMP}/lint-ran"
CHECK_STEPS_FILE="${TMP}/steps"
{
  printf 'gates\ttrue\n'
  printf 'lint:packages/sdk\tsleep 0.3 && touch %s\n' "${MARKER}"
  printf 'typecheck:packages/sdk\t[ -f %s ] && exit 0 || exit 9\n' "${MARKER}"
  printf 'test:packages/sdk\ttrue\n'
} > "${CHECK_STEPS_FILE}"

run_with_steps() {
  local steps_file="$1"
  shift
  CHECK_STEPS="$(cat "${steps_file}")" "$@"
}

assert_exit "a package-qualified lint step still blocks the matching typecheck step" 0 \
  run_with_steps "${CHECK_STEPS_FILE}" bash "${CHECK}"

gate_test_finish
