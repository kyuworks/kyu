#!/usr/bin/env bash
# Container entrypoint for the shop failure harness, run in-region against
# the deployed dev engine (issue #166). fly.toml's `[[restart]] policy =
# 'never'` leaves the machine `stopped` once this exits, so a run is exactly
# one deploy or one `fly machine start`.
#
# Never uses `set -x` and never echoes the environment: KYU_SHOP_DATABASE_URL
# and HATCHET_CLIENT_TOKEN carry real secrets on the deployed machine.
set -uo pipefail

REPORTS_DIR="${KYU_HARNESS_REPORTS_DIR:-/reports}"
SHOP_ROOT="${KYU_HARNESS_SHOP_ROOT:-examples/shop}"
SIZE="${KYU_HARNESS_SIZE:-report}"
HOLD_SECONDS="${KYU_HARNESS_HOLD_SECONDS:-900}"
API_URL="${HATCHET_CLIENT_API_URL:-http://localhost:8888}"

log() {
  printf '[harness] %s\n' "$*"
}

require_var() {
  local name="$1" value="${!1:-}"
  if [ -z "${value}" ]; then
    echo "FAIL: missing required environment variable: ${name}" >&2
    exit 2
  fi
}

require_var KYU_SHOP_DATABASE_URL
require_var HATCHET_CLIENT_TOKEN
: "${KYU_HARNESS_SCENARIOS:?KYU_HARNESS_SCENARIOS is required}"

mkdir -p "${REPORTS_DIR}"

log "preflight-start url=${API_URL}/api/ready"
PREFLIGHT_STATUS="$(node -e '
const url = process.argv[1] + "/api/ready"
fetch(url)
  .then((response) => { process.stdout.write(String(response.status)); process.exit(response.ok ? 0 : 1) })
  .catch(() => { process.stdout.write("0"); process.exit(1) })
' "${API_URL}")"
PREFLIGHT_RC=$?
if [ "${PREFLIGHT_RC}" -ne 0 ]; then
  echo "FAIL: preflight failed url=${API_URL}/api/ready status=${PREFLIGHT_STATUS}" >&2
  exit 3
fi
log "preflight-ok url=${API_URL}/api/ready status=${PREFLIGHT_STATUS}"

node "${SHOP_ROOT}/dist/bin/migrate.js"
log "migrate-done"

WORST_EXIT=0
for scenario in ${KYU_HARNESS_SCENARIOS}; do
  out="${REPORTS_DIR}/${scenario}.json"
  rc=0
  node "${SHOP_ROOT}/dist/__tests__/harness/run.js" --scenario "${scenario}" --size "${SIZE}" --out "${out}" || rc=$?
  if [ "${rc}" -gt "${WORST_EXIT}" ]; then
    WORST_EXIT="${rc}"
  fi
  sha="$(sha256sum "${out}" | awk '{print $1}')"
  printf '%s  %s\n' "${sha}" "$(basename "${out}")" > "${out}.sha256"
  bytes="$(wc -c < "${out}" | tr -d ' ')"
  log "report-written scenario=${scenario} bytes=${bytes} sha256=${sha} exit=${rc}"
done

: > "${REPORTS_DIR}/done"
log "harness-done worst_exit=${WORST_EXIT}"

sleep "${HOLD_SECONDS}"
exit "${WORST_EXIT}"
