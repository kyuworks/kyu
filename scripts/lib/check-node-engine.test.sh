#!/usr/bin/env bash
# Unit tests for check-node-engine.sh (#1549).
# Run: bash scripts/lib/check-node-engine.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/gate-test-lib.sh"

PREFLIGHT="${SCRIPT_DIR}/check-node-engine.sh"
CHECK="${SCRIPT_DIR}/../check.sh"
CHANGED="${SCRIPT_DIR}/../check-changed.sh"
VERIFY="${SCRIPT_DIR}/../verify-gates.sh"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "=== check-node-engine.sh tests ==="

assert_exit "preflight script exists" 0 test -f "${PREFLIGHT}"

# --- Out of spec: names running version and the range from package.json ---
printf '%s\n' '{"engines":{"node":">=99.0.0"}}' > "${TMP}/high.json"
assert_exit "range from package.json rejects current Node" 1 \
  env CHECK_NODE_ENGINE_PACKAGE="${TMP}/high.json" bash "${PREFLIGHT}"
assert_output_contains "message names the package.json range" ">=99.0.0" \
  env CHECK_NODE_ENGINE_PACKAGE="${TMP}/high.json" bash "${PREFLIGHT}"
RUNNING="$(node -p 'process.version')"
assert_output_contains "message names the running Node" "${RUNNING}" \
  env CHECK_NODE_ENGINE_PACKAGE="${TMP}/high.json" bash "${PREFLIGHT}"

assert_exit "injected old Node is rejected" 1 \
  env CHECK_NODE_ENGINE_VERSION=v22.23.2 bash "${PREFLIGHT}"
assert_output_contains "injected old Node is named" "v22.23.2" \
  env CHECK_NODE_ENGINE_VERSION=v22.23.2 bash "${PREFLIGHT}"

REQUIRED="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).engines.node" "${ROOT_DIR}/package.json")"
assert_output_contains "real package.json range is named" "${REQUIRED}" \
  env CHECK_NODE_ENGINE_VERSION=v22.23.2 bash "${PREFLIGHT}"

if [ ! -f "${PREFLIGHT}" ]; then
  gate_test_record "preflight does not copy engines.node" 1
elif grep -qF -- "${REQUIRED#>=}" "${PREFLIGHT}"; then
  gate_test_record "preflight does not copy engines.node" 1
  echo "----- ${PREFLIGHT} -----"
  grep -nF -- "${REQUIRED#>=}" "${PREFLIGHT}" || true
  echo "------------------------"
else
  gate_test_record "preflight does not copy engines.node" 0
fi

# --- Supported Node is silent ---
printf '%s\n' '{"engines":{"node":">=0.0.0"}}' > "${TMP}/low.json"
assert_exit "range that current Node satisfies exits 0" 0 \
  env CHECK_NODE_ENGINE_PACKAGE="${TMP}/low.json" bash "${PREFLIGHT}"
if [ -z "${GATE_TEST_LAST_OUT}" ]; then
  gate_test_record "satisfying Node produces no output" 0
else
  gate_test_record "satisfying Node produces no output" 1
  _gate_test_dump "${GATE_TEST_LAST_OUT}"
fi

assert_exit "current Node against repo package.json exits 0" 0 bash "${PREFLIGHT}"
if [ -z "${GATE_TEST_LAST_OUT}" ]; then
  gate_test_record "repo-supported Node produces no output" 0
else
  gate_test_record "repo-supported Node produces no output" 1
  _gate_test_dump "${GATE_TEST_LAST_OUT}"
fi

# --- Message appears before any gate / selected step ---
MARKER="${TMP}/later.step"
rm -f "${MARKER}"
assert_exit "check.sh exits non-zero on old Node" 1 \
  env CHECK_NODE_ENGINE_VERSION=v22.23.2 \
      CHECK_STEPS="$(printf 'later\ttouch %s' "${MARKER}")" \
      bash "${CHECK}"
if [ -e "${MARKER}" ]; then
  gate_test_record "check.sh does not run steps on old Node" 1
else
  gate_test_record "check.sh does not run steps on old Node" 0
fi
assert_output_contains "check.sh names the old Node" "v22.23.2" \
  env CHECK_NODE_ENGINE_VERSION=v22.23.2 \
      CHECK_STEPS="$(printf 'later\ttouch %s' "${MARKER}")" \
      bash "${CHECK}"
_gate_test_capture \
  env CHECK_NODE_ENGINE_VERSION=v22.23.2 \
      CHECK_STEPS="$(printf 'later\ttouch %s' "${MARKER}")" \
      bash "${CHECK}"
if grep -qF 'FAILED: later' <<< "${GATE_TEST_LAST_OUT}"; then
  gate_test_record "check.sh does not report a later step on old Node" 1
  _gate_test_dump "${GATE_TEST_LAST_OUT}"
else
  gate_test_record "check.sh does not report a later step on old Node" 0
fi

_gate_test_capture \
  env CHECK_NODE_ENGINE_VERSION=v22.23.2 bash "${CHANGED}" --dry-run
if [ "${GATE_TEST_LAST_RC}" -ne 0 ] \
  && grep -qF 'v22.23.2' <<< "${GATE_TEST_LAST_OUT}" \
  && ! grep -qF 'selected' <<< "${GATE_TEST_LAST_OUT}"; then
  gate_test_record "check-changed.sh fails before selecting checks" 0
else
  gate_test_record "check-changed.sh fails before selecting checks" 1
  _gate_test_dump "${GATE_TEST_LAST_OUT}"
fi

# --- Removing the call from an entry point fails this suite ---
for pair in \
  "${CHECK}|scripts/check.sh" \
  "${CHANGED}|scripts/check-changed.sh" \
  "${VERIFY}|scripts/verify-gates.sh"
do
  file="${pair%%|*}"
  label="${pair#*|}"
  if grep -qF 'bash scripts/lib/check-node-engine.sh' "${file}"; then
    gate_test_record "removed-preflight-fails-test (${label} invokes it)" 0
  else
    gate_test_record "removed-preflight-fails-test (${label} invokes it)" 1
  fi
done

if grep -qF 'bash scripts/lib/check-node-engine.sh' "${VERIFY}"; then
  preflight_line="$(grep -nF 'bash scripts/lib/check-node-engine.sh' "${VERIFY}" | head -1 | cut -d: -f1)"
  banner_line="$(grep -nF '[verify:gates] === Architecture + security ===' "${VERIFY}" | head -1 | cut -d: -f1)"
  if [ -n "${preflight_line}" ] && [ -n "${banner_line}" ] && [ "${preflight_line}" -lt "${banner_line}" ]; then
    gate_test_record "verify-gates.sh runs the preflight before the first gate" 0
  else
    gate_test_record "verify-gates.sh runs the preflight before the first gate" 1
  fi
fi

gate_test_finish
