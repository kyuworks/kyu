#!/usr/bin/env bash
# Unit tests for collect.sh (#166). Run: bash infra/shop-harness/fly/collect.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../../scripts/lib/gate-test-lib.sh"
COLLECT="${SCRIPT_DIR}/collect.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT
mkdir -p "${TMP}/bin"

REPORT_CONTENT='{"commitSha":"abc123","scenarios":[]}'
REPORT_SHA="$(printf '%s' "${REPORT_CONTENT}" | shasum -a 256 | awk '{print $1}')"
BAD_SHA='0000000000000000000000000000000000000000000000000000000000000000'
NOT_JSON_CONTENT='not json at all'
NOT_JSON_SHA="$(printf '%s' "${NOT_JSON_CONTENT}" | shasum -a 256 | awk '{print $1}')"

# Fake fly: records every invocation and returns canned --json bodies keyed
# off which of the two commands (cat vs sha256sum) collect.sh asked for. The
# content and sha are written to files so the fake can JSON-encode them
# properly (the real report content itself contains quotes).
make_fake_fly() {
  local dir="$1" content="$2" sha="$3"
  mkdir -p "${dir}"
  printf '%s' "${content}" > "${dir}/content.txt"
  printf '%s' "${sha}" > "${dir}/sha.txt"
  cat > "${dir}/fly" <<FAKE_FLY
#!/usr/bin/env bash
DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
echo "\$*" >> "${TMP}/fly-calls.log"
for arg in "\$@"; do
  case "\${arg}" in
    cat\ *)
      node -e 'const fs=require("node:fs");process.stdout.write(JSON.stringify({stdout:fs.readFileSync(process.argv[1],"utf8")}))' "\${DIR}/content.txt"
      exit 0
      ;;
    sha256sum\ *)
      node -e 'const fs=require("node:fs");process.stdout.write(JSON.stringify({stdout:fs.readFileSync(process.argv[1],"utf8")+"  /reports/report.json\n"}))' "\${DIR}/sha.txt"
      exit 0
      ;;
  esac
done
echo "unexpected fly invocation: \$*" >&2
exit 9
FAKE_FLY
  chmod +x "${dir}/fly"
}

echo "=== collect.sh tests ==="
assert_exit "script exists" 0 test -f "${COLLECT}"

# --- matching sha writes -o ---
: > "${TMP}/fly-calls.log"
make_fake_fly "${TMP}/ok" "${REPORT_CONTENT}" "${REPORT_SHA}"
assert_exit "matching sha exits 0" 0 env "PATH=${TMP}/ok:${PATH}" bash "${COLLECT}" \
  -a <shop-harness-app> -m 1234abcd -s outbox-backlog -o "${TMP}/out-ok.json"
assert_exit "matching sha writes the out file" 0 test -f "${TMP}/out-ok.json"
assert_eq "written file matches the report content" "${REPORT_CONTENT}" "$(cat "${TMP}/out-ok.json")"

# --- mismatched sha exits non-zero and writes nothing ---
: > "${TMP}/fly-calls.log"
make_fake_fly "${TMP}/bad-sha" "${REPORT_CONTENT}" "${BAD_SHA}"
assert_exit "mismatched sha exits non-zero" nonzero env "PATH=${TMP}/bad-sha:${PATH}" bash "${COLLECT}" \
  -a <shop-harness-app> -m 1234abcd -s outbox-backlog -o "${TMP}/out-badsha.json"
assert_exit "mismatched sha writes nothing" nonzero test -f "${TMP}/out-badsha.json"

# --- non-JSON content exits non-zero (sha matches, content still refused) ---
: > "${TMP}/fly-calls.log"
make_fake_fly "${TMP}/not-json" "${NOT_JSON_CONTENT}" "${NOT_JSON_SHA}"
assert_exit "non-JSON content exits non-zero" nonzero env "PATH=${TMP}/not-json:${PATH}" bash "${COLLECT}" \
  -a <shop-harness-app> -m 1234abcd -s outbox-backlog -o "${TMP}/out-notjson.json"
assert_exit "non-JSON content writes nothing" nonzero test -f "${TMP}/out-notjson.json"

# --- a scenario name with / or a space is rejected before fly is called ---
: > "${TMP}/fly-calls.log"
mkdir -p "${TMP}/reject/bin"
printf '%s\n' '#!/usr/bin/env bash' "echo \"\$*\" >> \"${TMP}/fly-calls.log\"" 'exit 9' > "${TMP}/reject/fly"
chmod +x "${TMP}/reject/fly"
assert_exit "scenario with a slash is rejected" nonzero env "PATH=${TMP}/reject:${PATH}" bash "${COLLECT}" \
  -a <shop-harness-app> -m 1234abcd -s "outbox/backlog" -o "${TMP}/out-slash.json"
assert_exit "scenario with a space is rejected" nonzero env "PATH=${TMP}/reject:${PATH}" bash "${COLLECT}" \
  -a <shop-harness-app> -m 1234abcd -s "outbox backlog" -o "${TMP}/out-space.json"
gate_test_record "rejected scenario names never invoked fly" "$([ ! -s "${TMP}/fly-calls.log" ] && echo 0 || echo 1)"

# --- every recorded fly call is exactly one of the two allowed forms ---
: > "${TMP}/fly-calls.log"
make_fake_fly "${TMP}/ok2" "${REPORT_CONTENT}" "${REPORT_SHA}"
PATH="${TMP}/ok2:${PATH}" bash "${COLLECT}" -a <shop-harness-app> -m 1234abcd -s outbox-backlog -o "${TMP}/out-ok2.json" >/dev/null
BAD_CALLS="$(grep -vE '(^| )machine exec 1234abcd (cat|sha256sum) /reports/outbox-backlog\.json( |$)' "${TMP}/fly-calls.log" || true)"
assert_eq "every fly call is exactly cat or sha256sum on the scenario's report path" "" "${BAD_CALLS}"
CALL_COUNT="$(wc -l < "${TMP}/fly-calls.log" | tr -d ' ')"
assert_eq "exactly two fly calls" 2 "${CALL_COUNT}"

gate_test_finish
