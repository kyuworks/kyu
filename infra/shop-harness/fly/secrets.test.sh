#!/usr/bin/env bash
# Unit tests for secrets.sh (#166, #204). Run: bash infra/shop-harness/fly/secrets.test.sh
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

for name in KYU_SHOP_DATABASE_URL HATCHET_CLIENT_TOKEN HATCHET_CLIENT_HOST_PORT HATCHET_CLIENT_API_URL; do
  assert_output_contains "names ${name}" "${name}" bash "${SECRETS}"
done
assert_output_contains "names the app placeholder" "<shop-harness-app>" bash "${SECRETS}"
assert_output_contains "stages the secrets" "--stage" bash "${SECRETS}"

OUT="$(bash "${SECRETS}")"
SET_LINES="$(printf '%s\n' "${OUT}" | grep 'fly secrets set' || true)"
BAD_SET_LINES="$(printf '%s\n' "${SET_LINES}" | grep -vE "='<REPLACE_ME>'\$" || true)"
assert_eq "every fly secrets set line ends in ='<REPLACE_ME>'" "" "${BAD_SET_LINES}"
gate_test_record "at least one fly secrets set line" "$([ -n "${SET_LINES}" ] && echo 0 || echo 1)"

TOKEN_LINE="$(printf '%s\n' "${OUT}" | grep 'HATCHET_CLIENT_TOKEN=' | grep 'fly secrets import' || true)"
gate_test_record "token line uses fly secrets import --stage" "$([[ "${TOKEN_LINE}" == *'fly secrets import --stage'* ]] && echo 0 || echo 1)"
gate_test_record "token line reads token.sh -a the engine app placeholder" "$([[ "${TOKEN_LINE}" == *"infra/hatchet/fly/token.sh -a '<engine-app>'"* ]] && echo 0 || echo 1)"

STAGE_COMMAND_LINES="$(printf '%s\n' "${OUT}" | grep -E '^fly secrets set|\| fly secrets import')"
NO_STAGE_LINES="$(printf '%s\n' "${STAGE_COMMAND_LINES}" | grep -v -- '--stage' || true)"
assert_eq "--stage is on every fly secrets command" "" "${NO_STAGE_LINES}"

# A Fly cluster id is 16 lowercase letters and digits. The text carries none.
CLUSTER_IDS="$(printf '%s\n' "${OUT}" | grep -oE '(^|[^A-Za-z0-9_-])[a-z0-9]{16}([^A-Za-z0-9_-]|$)' | grep -oE '[a-z0-9]{16}' || true)"
assert_eq "prints no cluster id" "" "${CLUSTER_IDS}"
gate_test_record "says where to read the new shop cluster id" "$([[ "${OUT}" == *'fly mpg list -o <fly-org>'* ]] && echo 0 || echo 1)"
gate_test_record "still warns off the engine's cluster" "$([[ "${OUT}" == *"the engine's cluster (<engine-db>)"* ]] && echo 0 || echo 1)"
assert_output_lacks "never echoes a value from its environment" "sentinel-204" \
  env KYU_SHOP_DATABASE_URL=postgresql://u:sentinel-204@h/db HATCHET_CLIENT_TOKEN=sentinel-204 bash "${SECRETS}"

gate_test_finish
