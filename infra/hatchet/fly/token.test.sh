#!/usr/bin/env bash
# Unit tests for fly/token.sh (#162). Run: bash infra/hatchet/fly/token.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../../scripts/lib/gate-test-lib.sh"
TOKEN="${SCRIPT_DIR}/token.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT
mkdir -p "${TMP}/bin"
printf '%s\n' '#!/usr/bin/env bash' "touch \"${TMP}/fly-was-called\"" 'exit 1' > "${TMP}/bin/fly"
chmod +x "${TMP}/bin/fly"
mkdir -p "${TMP}/ok"
printf '%s\n' '#!/usr/bin/env bash' 'printf "fake.worker.token\r\n"' > "${TMP}/ok/fly"
chmod +x "${TMP}/ok/fly"
mkdir -p "${TMP}/banner"
printf '%s\n' '#!/usr/bin/env bash' \
  'printf "Update available 0.4.1 -> 0.4.2.\r\n"' \
  'printf "fake.worker.token\r\n"' > "${TMP}/banner/fly"
chmod +x "${TMP}/banner/fly"

echo "=== fly/token.sh tests ==="
assert_exit "script exists" 0 test -f "${TOKEN}"
assert_exit "no app name is rejected" 2 env "PATH=${TMP}/bin:${PATH}" bash "${TOKEN}"
assert_output_contains "rejection prints usage" "usage:" env "PATH=${TMP}/bin:${PATH}" bash "${TOKEN}"
assert_exit "unknown flag is rejected" 2 env "PATH=${TMP}/bin:${PATH}" bash "${TOKEN}" --wat
assert_exit "-a with no value is rejected" 2 env "PATH=${TMP}/bin:${PATH}" bash "${TOKEN}" -a
gate_test_record "validation never invoked fly" "$([ -e "${TMP}/fly-was-called" ] && echo 1 || echo 0)"
OUT="$(PATH="${TMP}/ok:${PATH}" bash "${TOKEN}" -a <engine-app>)"
gate_test_record "stdout is exactly the token" "$([ "${OUT}" = "fake.worker.token" ] && echo 0 || echo 1)"
BANNER_OUT="$(PATH="${TMP}/banner:${PATH}" bash "${TOKEN}" -a <engine-app>)"
gate_test_record "a banner line before the token is dropped" "$([ "${BANNER_OUT}" = "fake.worker.token" ] && echo 0 || echo 1)"
gate_test_finish
