#!/usr/bin/env bash
# Unit tests for run-isolated-selftest.sh: it must clear the git hook env
# vars before the target suite runs, and pass through its exit code and
# stdout unchanged.
#
# Builds no git repository (only inspects env vars via a probe script), so
# check-selftest-git-isolation.sh's rule does not apply to this suite.
# Run: bash scripts/lib/run-isolated-selftest.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/gate-test-lib.sh"
WRAPPER="${SCRIPT_DIR}/run-isolated-selftest.sh"

echo "=== run-isolated-selftest tests ==="

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

PROBE="${WORK}/probe.test.sh"
cat <<'SH' > "${PROBE}"
#!/usr/bin/env bash
set -uo pipefail
if [ -n "${GIT_DIR:-}" ]; then
  echo "GIT_DIR=set"
else
  echo "GIT_DIR=unset"
fi
if [ -n "${GIT_INDEX_FILE:-}" ]; then
  echo "GIT_INDEX_FILE=set"
else
  echo "GIT_INDEX_FILE=unset"
fi
echo "PROBE_STDOUT_MARKER"
exit 7
SH
chmod 755 "${PROBE}"

run_probe() {
  env GIT_DIR="${WORK}/fake-git-dir" GIT_INDEX_FILE="${WORK}/fake-index" \
    bash "${WRAPPER}" "${PROBE}"
}

assert_exit "usage error without a script argument" 2 bash "${WRAPPER}"

assert_output_contains "wrapper clears GIT_DIR before the probe runs" "GIT_DIR=unset" run_probe
assert_output_contains "wrapper clears GIT_INDEX_FILE before the probe runs" "GIT_INDEX_FILE=unset" run_probe
assert_exit "wrapper passes through the probe's exit code" 7 run_probe
assert_output_contains "probe stdout reaches the caller" "PROBE_STDOUT_MARKER" run_probe

gate_test_finish
