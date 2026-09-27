#!/usr/bin/env bash
# Unit tests for check-integration-shards.sh.
# Run: bash scripts/gates/check-integration-shards.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-integration-shards.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

cat > "${TMP}/list.sh" <<'EOF'
cat "files-${KYU_INTEGRATION_SHARD:-all}.txt"
EOF
LIST_CMD="bash ${TMP}/list.sh"

# make_suite <dir> <all> <shard 1> <shard 2>; each list is space-separated.
make_suite() {
  local dir="${TMP}/repo/$1"
  mkdir -p "${dir}"
  : > "${dir}/vitest.integration.config.ts"
  printf '%s\n' $2 > "${dir}/files-all.txt"
  printf '%s\n' $3 > "${dir}/files-1.txt"
  printf '%s\n' $4 > "${dir}/files-2.txt"
}

run_check() {
  ROOT_DIR="${TMP}/repo" SHARD_LIST_CMD="${LIST_CMD}" bash "${CHECK}"
}

A=src/a.integration.test.ts
B=src/b.integration.test.ts
C=src/c.integration.test.ts

echo "=== check-integration-shards tests ==="

rm -rf "${TMP}/repo"; make_suite packages/sdk "$A $B $C" "$A" "$B $C"
assert_exit "every file in exactly one shard is accepted" 0 run_check

rm -rf "${TMP}/repo"; make_suite packages/sdk "$A $B $C" "$A" "$B"
assert_exit "a file in no shard is rejected" 1 run_check
assert_output_contains "the dropped file is named" "in no shard: ${C}" run_check

rm -rf "${TMP}/repo"; make_suite packages/sdk "$A $B $C" "$A $B" "$B $C"
assert_exit "a file in both shards is rejected" 1 run_check
assert_output_contains "the doubled file is named" "in both shards: ${B}" run_check

rm -rf "${TMP}/repo"; make_suite packages/sdk "$A $B" "" "$A $B"
assert_exit "an empty shard is rejected" 1 run_check

rm -rf "${TMP}/repo"; make_suite packages/sdk "$A $B" "$A" "$B"; rm "${TMP}/repo/packages/sdk/files-2.txt"
assert_exit "a listing that fails is rejected" 1 run_check

rm -rf "${TMP}/repo"; make_suite packages/sdk "$A $B" "$A" "$B"; make_suite examples/shop "$A $B" "$A" ""
assert_exit "a broken suite under examples/ is rejected" 1 run_check

rm -rf "${TMP}/repo"; mkdir -p "${TMP}/repo/packages/sdk"
assert_exit "a repo with no integration suite is rejected" 1 run_check

assert_exit "real repo integration shards run every file exactly once" 0 bash "${CHECK}"

gate_test_finish
