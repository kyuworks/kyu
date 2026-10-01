#!/usr/bin/env bash
# Unit tests for collect.sh (#166, #173). Run: bash infra/shop-harness/fly/collect.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../../scripts/lib/gate-test-lib.sh"
COLLECT="${SCRIPT_DIR}/collect.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT

REPORT_CONTENT='{"commitSha":"abc123","scenarios":[]}'
BAD_SHA='0000000000000000000000000000000000000000000000000000000000000000'

sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# Fake fly. Answers the machine commands collect.sh may run against a report
# held in <dir>/content.txt, the way `fly machine exec --json` does: an empty
# stdout is left out of the JSON. Any answer over 1,500,000 characters fails,
# like the real exec did for a 6.7 MB report (#173); 1.8 MB was the largest
# that got through. <dir>/sha.txt is what sha256sum reports.
make_fake_fly() {
  local dir="$1" content_file="$2" sha="$3"
  mkdir -p "${dir}"
  cp "${content_file}" "${dir}/content.txt"
  printf '%s' "${sha}" > "${dir}/sha.txt"
  cat > "${dir}/fly" <<FAKE_FLY
#!/usr/bin/env bash
DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
echo "\$*" >> "${TMP}/fly-calls.log"
node - "\${DIR}" "\$4" <<'NODE'
const fs = require('node:fs')
const [dir, cmd] = process.argv.slice(2)
const content = fs.readFileSync(dir + '/content.txt')
let stdout
if (cmd.startsWith('cat ')) stdout = content.toString('utf8')
else if (cmd.startsWith('wc -c ')) stdout = content.length + ' ' + cmd.slice(6) + '\n'
else if (cmd.startsWith('split ')) stdout = ''
else if (cmd.startsWith('base64 -w0 ')) {
  const part = Number(cmd.slice(-3))
  stdout = content.subarray(part * 1000000, (part + 1) * 1000000).toString('base64')
} else if (cmd.startsWith('sha256sum ')) stdout = fs.readFileSync(dir + '/sha.txt', 'utf8') + '  ' + cmd.slice(10) + '\n'
else { process.stderr.write('unexpected machine command: ' + cmd + '\n'); process.exit(9) }
if (stdout.length > 1500000) { process.stderr.write('Error: could not exec command on machine\n'); process.exit(1) }
process.stdout.write(JSON.stringify(stdout === '' ? {} : { stdout }))
NODE
FAKE_FLY
  chmod +x "${dir}/fly"
}

echo "=== collect.sh tests ==="
assert_exit "script exists" 0 test -f "${COLLECT}"

printf '%s' "${REPORT_CONTENT}" > "${TMP}/small.json"
printf '%s' 'not json at all' > "${TMP}/not-json.txt"
# 2.5 MB of JSON with a two-byte character across the first part boundary.
node -e '
const head = "{\"pad\":\"" + "x".repeat(999999 - 8)
process.stdout.write(head + "é" + "y".repeat(1500000) + "\",\"scenarios\":[]}")
' > "${TMP}/large.json"

# --- matching sha writes -o ---
: > "${TMP}/fly-calls.log"
make_fake_fly "${TMP}/ok" "${TMP}/small.json" "$(sha_of "${TMP}/small.json")"
assert_exit "matching sha exits 0" 0 env "PATH=${TMP}/ok:${PATH}" bash "${COLLECT}" \
  -a test-harness-app -m 1234abcd -s outbox-backlog -o "${TMP}/out-ok.json"
assert_exit "matching sha writes the out file" 0 test -f "${TMP}/out-ok.json"
assert_eq "written file matches the report content" "${REPORT_CONTENT}" "$(cat "${TMP}/out-ok.json")"

# --- a report larger than one exec can return is collected byte for byte ---
: > "${TMP}/fly-calls.log"
make_fake_fly "${TMP}/large" "${TMP}/large.json" "$(sha_of "${TMP}/large.json")"
assert_exit "a 2.5 MB report is collected" 0 env "PATH=${TMP}/large:${PATH}" bash "${COLLECT}" \
  -a test-harness-app -m 1234abcd -s outbox-backlog -o "${TMP}/out-large.json"
assert_eq "the 2.5 MB report is written byte for byte" "$(sha_of "${TMP}/large.json")" \
  "$(sha_of "${TMP}/out-large.json" 2>/dev/null || echo missing)"
assert_eq "the 2.5 MB report is read in three parts" 3 "$(grep -c ' base64 -w0 ' "${TMP}/fly-calls.log")"

# --- mismatched sha exits non-zero and writes nothing ---
make_fake_fly "${TMP}/bad-sha" "${TMP}/small.json" "${BAD_SHA}"
assert_exit "mismatched sha exits non-zero" nonzero env "PATH=${TMP}/bad-sha:${PATH}" bash "${COLLECT}" \
  -a test-harness-app -m 1234abcd -s outbox-backlog -o "${TMP}/out-badsha.json"
assert_exit "mismatched sha writes nothing" nonzero test -f "${TMP}/out-badsha.json"

# --- non-JSON content exits non-zero (sha matches, content still refused) ---
make_fake_fly "${TMP}/not-json" "${TMP}/not-json.txt" "$(sha_of "${TMP}/not-json.txt")"
assert_exit "non-JSON content exits non-zero" nonzero env "PATH=${TMP}/not-json:${PATH}" bash "${COLLECT}" \
  -a test-harness-app -m 1234abcd -s outbox-backlog -o "${TMP}/out-notjson.json"
assert_exit "non-JSON content writes nothing" nonzero test -f "${TMP}/out-notjson.json"

# --- a scenario name with / or a space is rejected before fly is called ---
: > "${TMP}/fly-calls.log"
mkdir -p "${TMP}/reject"
printf '%s\n' '#!/usr/bin/env bash' "echo \"\$*\" >> \"${TMP}/fly-calls.log\"" 'exit 9' > "${TMP}/reject/fly"
chmod +x "${TMP}/reject/fly"
assert_exit "scenario with a slash is rejected" nonzero env "PATH=${TMP}/reject:${PATH}" bash "${COLLECT}" \
  -a test-harness-app -m 1234abcd -s "outbox/backlog" -o "${TMP}/out-slash.json"
assert_exit "scenario with a space is rejected" nonzero env "PATH=${TMP}/reject:${PATH}" bash "${COLLECT}" \
  -a test-harness-app -m 1234abcd -s "outbox backlog" -o "${TMP}/out-space.json"
gate_test_record "rejected scenario names never invoked fly" "$([ ! -s "${TMP}/fly-calls.log" ] && echo 0 || echo 1)"

# --- every fly call is one of the four read-only forms, on this scenario only ---
: > "${TMP}/fly-calls.log"
PATH="${TMP}/ok:${PATH}" bash "${COLLECT}" -a test-harness-app -m 1234abcd -s outbox-backlog -o "${TMP}/out-ok2.json" >/dev/null
ALLOWED='^machine exec 1234abcd (wc -c /reports/outbox-backlog\.json|split -b 1000000 -d -a 3 /reports/outbox-backlog\.json /tmp/kyu-collect-outbox-backlog\.part\.|base64 -w0 /tmp/kyu-collect-outbox-backlog\.part\.[0-9]{3}|sha256sum /reports/outbox-backlog\.json) --json -a test-harness-app$'
assert_eq "every fly call is wc, split, base64 or sha256sum on the scenario's report" "" \
  "$(grep -vE "${ALLOWED}" "${TMP}/fly-calls.log" || true)"
assert_eq "a small report takes exactly four fly calls" 4 "$(wc -l < "${TMP}/fly-calls.log" | tr -d ' ')"

# --- the usage text says the machine must stay running until the collect is done ---
assert_output_contains "usage says to keep the machine running until collected" \
  "keep the machine running until this prints 'collected'" bash "${COLLECT}" --help

gate_test_finish
