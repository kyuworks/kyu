#!/usr/bin/env bash
# Unit tests for secrets.sh (#162). Run: bash infra/hatchet/fly/secrets.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../../scripts/lib/gate-test-lib.sh"
SECRETS="${SCRIPT_DIR}/secrets.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT
mkdir -p "${TMP}/bin"
printf '%s\n' '#!/usr/bin/env bash' "touch \"${TMP}/fly-was-called\"" 'exit 1' > "${TMP}/bin/fly"
chmod +x "${TMP}/bin/fly"

echo "=== secrets.sh tests ==="
assert_exit "script exists" 0 test -f "${SECRETS}"
assert_exit "prints without calling fly" 0 env "PATH=${TMP}/bin:${PATH}" bash "${SECRETS}"
gate_test_record "never invoked fly" "$([ -e "${TMP}/fly-was-called" ] && echo 1 || echo 0)"
for name in DATABASE_URL SERVER_AUTH_COOKIE_SECRETS SERVER_ENCRYPTION_MASTER_KEYSET \
            SERVER_ENCRYPTION_JWT_PRIVATE_KEYSET SERVER_ENCRYPTION_JWT_PUBLIC_KEYSET \
            SERVER_AUTH_ADMIN_EMAIL SERVER_AUTH_ADMIN_PASSWORD; do
  assert_output_contains "names ${name}" "${name}" bash "${SECRETS}"
done
assert_output_contains "names the app" "<engine-app>" bash "${SECRETS}"
assert_output_contains "stages the secrets" "--stage" bash "${SECRETS}"
assert_output_lacks "carries no password" "Admin123" bash "${SECRETS}"
assert_output_contains "marks the keysets optional" "Optional overrides" bash "${SECRETS}"

OUT="$(bash "${SECRETS}")"
SET_LINE_COUNT="$(printf '%s\n' "${OUT}" | grep -c 'fly secrets set' || true)"
PLACEHOLDER_COUNT="$(printf '%s\n' "${OUT}" | grep -o '<REPLACE_ME>' | wc -l | tr -d ' ')"
assert_eq "one <REPLACE_ME> per fly secrets set line" "${SET_LINE_COUNT}" "${PLACEHOLDER_COUNT}"
BAD_LINES="$(printf '%s\n' "${OUT}" | grep 'fly secrets set' | grep -vE "='<REPLACE_ME>'\$" || true)"
assert_eq "every fly secrets set line ends in ='<REPLACE_ME>'" "" "${BAD_LINES}"
REQUIRED_COUNT="$(printf '%s\n' "${OUT}" | sed '/Optional overrides/q' | grep -c 'fly secrets set' || true)"
assert_eq "three required secrets" 3 "${REQUIRED_COUNT}"
gate_test_finish
