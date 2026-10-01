#!/usr/bin/env bash
# Unit tests for check-package-versions.sh.
# Run: bash scripts/gates/check-package-versions.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-package-versions.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
echo "=== check-package-versions tests ==="

# write_repo root schemas-version sdk-version sdk-range sdk-const
write_repo() {
  local root="$1" sv="$2" kv="$3" range="$4" const="$5"
  mkdir -p "${root}/packages/schemas" "${root}/packages/sdk/src" "${root}/packages/shop"
  printf '{ "name": "@fixture/kyu-schemas", "version": "%s" }\n' "${sv}" > "${root}/packages/schemas/package.json"
  printf '{ "name": "@fixture/kyu-sdk", "version": "%s", "dependencies": { "@fixture/kyu-schemas": "%s" } }\n' \
    "${kv}" "${range}" > "${root}/packages/sdk/package.json"
  printf '{ "name": "@fixture/kyu-shop", "version": "9.9.9", "private": true }\n' > "${root}/packages/shop/package.json"
  printf "export const SDK_VERSION = '%s'\n" "${const}" > "${root}/packages/sdk/src/version.ts"
}

OK="${WORK}/ok"
write_repo "${OK}" 0.1.0 0.1.0 'workspace:*' 0.1.0
assert_exit "same version everywhere passes (private package ignored)" 0 env ROOT_DIR="${OK}" bash "${CHECK}"
assert_exit "matching release tag passes" 0 env ROOT_DIR="${OK}" RELEASE_TAG=v0.1.0 bash "${CHECK}"
assert_exit "release tag for another version fails" 1 env ROOT_DIR="${OK}" RELEASE_TAG=v0.2.0 bash "${CHECK}"
assert_last_output_contains "failure names the tag" "tag v0.2.0"

DIFF="${WORK}/diff"
write_repo "${DIFF}" 0.1.0 0.2.0 'workspace:*' 0.2.0
assert_exit "two manifest versions fail" 1 env ROOT_DIR="${DIFF}" bash "${CHECK}"
assert_last_output_contains "failure says the versions differ" "versions differ"

RANGE="${WORK}/range"
write_repo "${RANGE}" 0.1.0 0.1.0 '^0.0.9' 0.1.0
assert_exit "a pinned sibling range fails" 1 env ROOT_DIR="${RANGE}" bash "${CHECK}"
assert_last_output_contains "failure names the dependency" "@fixture/kyu-schemas"

CONST="${WORK}/const"
write_repo "${CONST}" 0.1.0 0.1.0 'workspace:*' 0.0.0
assert_exit "a stale SDK_VERSION fails" 1 env ROOT_DIR="${CONST}" bash "${CHECK}"
assert_last_output_contains "failure names SDK_VERSION" "SDK_VERSION is 0.0.0"

assert_exit "verify-gates registers the package versions gate" 0 \
  grep -Fq 'bash scripts/gates/check-package-versions.sh' "${SCRIPT_DIR}/../verify-gates.sh"

gate_test_finish
