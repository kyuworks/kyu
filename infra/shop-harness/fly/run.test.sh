#!/usr/bin/env bash
# Unit tests for run.sh (#166). Run: bash infra/shop-harness/fly/run.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../../scripts/lib/gate-test-lib.sh"
RUN_SH="${SCRIPT_DIR}/run.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT

mkdir -p "${TMP}/bin" "${TMP}/reports" "${TMP}/shop-root/dist/bin" "${TMP}/shop-root/dist/__tests__/harness"
CALLS="${TMP}/calls.log"

# Fake node: records every invocation (argv) and behaves per env var, so the
# test drives run.sh's preflight/migrate/scenario steps without a real engine
# or a real build.
cat > "${TMP}/bin/node" <<'FAKE_NODE'
#!/usr/bin/env bash
echo "$*" >> "${FAKE_NODE_CALLS}"
if [ "$1" = "-e" ]; then
  status="${FAKE_PREFLIGHT_STATUS:-200}"
  printf '%s' "${status}"
  if [ "${FAKE_PREFLIGHT_OK:-1}" = "1" ]; then exit 0; else exit 1; fi
fi
case "$1" in
  */migrate.js)
    exit "${FAKE_MIGRATE_EXIT:-0}"
    ;;
  */run.js)
    scenario=""
    outp=""
    prev=""
    for arg in "$@"; do
      if [ "${prev}" = "--scenario" ]; then scenario="${arg}"; fi
      if [ "${prev}" = "--out" ]; then outp="${arg}"; fi
      prev="${arg}"
    done
    echo '{"scenarios":[]}' > "${outp}"
    var="FAKE_EXIT_$(printf '%s' "${scenario}" | tr 'a-z-' 'A-Z_')"
    exit "${!var:-0}"
    ;;
esac
exit 0
FAKE_NODE
chmod +x "${TMP}/bin/node"

run_env() {
  env \
    "PATH=${TMP}/bin:${PATH}" \
    "FAKE_NODE_CALLS=${CALLS}" \
    "KYU_HARNESS_REPORTS_DIR=${TMP}/reports" \
    "KYU_HARNESS_SHOP_ROOT=${TMP}/shop-root" \
    "KYU_SHOP_DATABASE_URL=${DB_URL:-db-secret-value}" \
    "HATCHET_CLIENT_TOKEN=${TOKEN:-token-secret-value}" \
    "HATCHET_CLIENT_API_URL=http://engine.example" \
    "KYU_HARNESS_SCENARIOS=${SCENARIOS:-outbox-backlog tenant-load}" \
    "KYU_HARNESS_SIZE=report" \
    "KYU_HARNESS_HOLD_SECONDS=${HOLD:-0}" \
    "${FAKE_ENV[@]}" \
    bash "${RUN_SH}"
}

echo "=== run.sh tests ==="
assert_exit "script exists" 0 test -f "${RUN_SH}"

# --- missing required var ---
: > "${CALLS}"
FAKE_ENV=()
assert_exit "missing KYU_SHOP_DATABASE_URL exits 2" 2 env \
  "PATH=${TMP}/bin:${PATH}" "FAKE_NODE_CALLS=${CALLS}" "KYU_HARNESS_REPORTS_DIR=${TMP}/reports" \
  "KYU_HARNESS_SHOP_ROOT=${TMP}/shop-root" "HATCHET_CLIENT_TOKEN=token-secret-value" \
  "KYU_HARNESS_SCENARIOS=outbox-backlog" "KYU_HARNESS_SIZE=report" "KYU_HARNESS_HOLD_SECONDS=0" \
  bash "${RUN_SH}"
assert_output_contains "missing-var message names the variable" "KYU_SHOP_DATABASE_URL" env \
  "PATH=${TMP}/bin:${PATH}" "FAKE_NODE_CALLS=${CALLS}" "KYU_HARNESS_REPORTS_DIR=${TMP}/reports" \
  "KYU_HARNESS_SHOP_ROOT=${TMP}/shop-root" "HATCHET_CLIENT_TOKEN=token-secret-value" \
  "KYU_HARNESS_SCENARIOS=outbox-backlog" "KYU_HARNESS_SIZE=report" "KYU_HARNESS_HOLD_SECONDS=0" \
  bash "${RUN_SH}"

# --- happy path: two scenarios, order, output shape, secrets never printed ---
: > "${CALLS}"
FAKE_ENV=(FAKE_EXIT_OUTBOX_BACKLOG=0 FAKE_EXIT_TENANT_LOAD=0)
OUT="$(run_env 2>&1)"
RC=$?
gate_test_record "happy path exits 0" "${RC}"
assert_output_lacks "output never contains the fake shop database secret" "db-secret-value" bash -c "printf '%s' \"\$1\"" _ "${OUT}"
if [[ "${OUT}" == *"token-secret-value"* ]]; then
  _gate_test_mark_fail "output never contains the fake engine token"
else
  _gate_test_mark_pass "output never contains the fake engine token"
fi
gate_test_record "migrate ran" "$(grep -q 'migrate.js' "${CALLS}" && echo 0 || echo 1)"
gate_test_record "one invocation per scenario" "$([ "$(grep -c 'run.js' "${CALLS}")" -eq 2 ] && echo 0 || echo 1)"
gate_test_record "outbox-backlog invoked with --size report and the right --out path" \
  "$(grep -q -- "--scenario outbox-backlog --size report --out ${TMP}/reports/outbox-backlog.json" "${CALLS}" && echo 0 || echo 1)"
MIGRATE_LINE="$(grep -n 'migrate.js' "${CALLS}" | head -1 | cut -d: -f1)"
FIRST_RUN_LINE="$(grep -n 'run.js' "${CALLS}" | head -1 | cut -d: -f1)"
gate_test_record "migrate runs before the first harness invocation" "$([ "${MIGRATE_LINE}" -lt "${FIRST_RUN_LINE}" ] && echo 0 || echo 1)"
assert_exit "writes the done marker" 0 test -f "${TMP}/reports/done"

# --- preflight failure exits 3 before migrate ---
: > "${CALLS}"
FAKE_ENV=(FAKE_PREFLIGHT_OK=0 FAKE_PREFLIGHT_STATUS=503)
assert_exit "preflight failure exits 3" 3 env \
  "PATH=${TMP}/bin:${PATH}" "FAKE_NODE_CALLS=${CALLS}" "KYU_HARNESS_REPORTS_DIR=${TMP}/reports" \
  "KYU_HARNESS_SHOP_ROOT=${TMP}/shop-root" "KYU_SHOP_DATABASE_URL=db-secret-value" \
  "HATCHET_CLIENT_TOKEN=token-secret-value" "HATCHET_CLIENT_API_URL=http://engine.example" \
  "KYU_HARNESS_SCENARIOS=outbox-backlog" "KYU_HARNESS_SIZE=report" "KYU_HARNESS_HOLD_SECONDS=0" \
  "FAKE_PREFLIGHT_OK=0" "FAKE_PREFLIGHT_STATUS=503" \
  bash "${RUN_SH}"
gate_test_record "preflight failure runs before migrate" "$(grep -q 'migrate.js' "${CALLS}" && echo 1 || echo 0)"

# --- worst scenario exit code wins, with HOLD_SECONDS=0 ---
: > "${CALLS}"
FAKE_ENV=(FAKE_EXIT_OUTBOX_BACKLOG=1 FAKE_EXIT_TENANT_LOAD=2)
HOLD=0
assert_exit "exits with the worst scenario code" 2 env \
  "PATH=${TMP}/bin:${PATH}" "FAKE_NODE_CALLS=${CALLS}" "KYU_HARNESS_REPORTS_DIR=${TMP}/reports" \
  "KYU_HARNESS_SHOP_ROOT=${TMP}/shop-root" "KYU_SHOP_DATABASE_URL=db-secret-value" \
  "HATCHET_CLIENT_TOKEN=token-secret-value" "HATCHET_CLIENT_API_URL=http://engine.example" \
  "KYU_HARNESS_SCENARIOS=outbox-backlog tenant-load" "KYU_HARNESS_SIZE=report" "KYU_HARNESS_HOLD_SECONDS=0" \
  "FAKE_EXIT_OUTBOX_BACKLOG=1" "FAKE_EXIT_TENANT_LOAD=2" \
  bash "${RUN_SH}"

gate_test_finish
