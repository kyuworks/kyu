#!/usr/bin/env bash
# Unit tests for check-tsconfig-references.sh.
# Run: bash scripts/gates/check-tsconfig-references.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-tsconfig-references.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
echo "=== check-tsconfig-references tests ==="

write_workspace() {
  local root="$1"
  mkdir -p "${root}"
  cat > "${root}/pnpm-workspace.yaml" <<'YAML'
packages:
  - 'packages/*'
  - 'examples/*'
YAML
}

# --- Every package with a tsconfig.json is referenced -> pass ---
OK="${WORK}/ok"
write_workspace "${OK}"
mkdir -p "${OK}/packages/schemas" "${OK}/packages/sdk" "${OK}/packages/no-ts"
printf '{}\n' > "${OK}/packages/schemas/tsconfig.json"
printf '{}\n' > "${OK}/packages/sdk/tsconfig.json"
# packages/no-ts has no tsconfig.json: not a TypeScript package, not required.
cat > "${OK}/tsconfig.json" <<'JSON'
{ "files": [], "references": [{ "path": "packages/schemas" }, { "path": "packages/sdk" }] }
JSON
assert_exit "every referenced package passes" 0 env ROOT_DIR="${OK}" bash "${CHECK}"
assert_output_contains "pass message" "OK:" env ROOT_DIR="${OK}" bash "${CHECK}"

# --- A workspace package with a tsconfig.json missing from references -> fail ---
BAD="${WORK}/bad"
write_workspace "${BAD}"
mkdir -p "${BAD}/packages/schemas" "${BAD}/packages/sdk"
printf '{}\n' > "${BAD}/packages/schemas/tsconfig.json"
printf '{}\n' > "${BAD}/packages/sdk/tsconfig.json"
cat > "${BAD}/tsconfig.json" <<'JSON'
{ "files": [], "references": [{ "path": "packages/schemas" }] }
JSON
assert_exit "missing package reference fails" 1 env ROOT_DIR="${BAD}" bash "${CHECK}"
assert_output_contains "failure names the missing package" "packages/sdk" \
  env ROOT_DIR="${BAD}" bash "${CHECK}"

# --- examples/* is scanned the same way as packages/* ---
EXBAD="${WORK}/exbad"
write_workspace "${EXBAD}"
mkdir -p "${EXBAD}/packages/schemas" "${EXBAD}/examples/playground"
printf '{}\n' > "${EXBAD}/packages/schemas/tsconfig.json"
printf '{}\n' > "${EXBAD}/examples/playground/tsconfig.json"
cat > "${EXBAD}/tsconfig.json" <<'JSON'
{ "files": [], "references": [{ "path": "packages/schemas" }] }
JSON
assert_exit "missing example reference fails" 1 env ROOT_DIR="${EXBAD}" bash "${CHECK}"
assert_output_contains "failure names the missing example" "examples/playground" \
  env ROOT_DIR="${EXBAD}" bash "${CHECK}"

# --- No examples/ directory at all -> pass (matches this branch today) ---
NOEX="${WORK}/noex"
write_workspace "${NOEX}"
mkdir -p "${NOEX}/packages/schemas"
printf '{}\n' > "${NOEX}/packages/schemas/tsconfig.json"
cat > "${NOEX}/tsconfig.json" <<'JSON'
{ "files": [], "references": [{ "path": "packages/schemas" }] }
JSON
assert_exit "no examples/ directory still passes" 0 env ROOT_DIR="${NOEX}" bash "${CHECK}"

# --- Missing workspace or tsconfig file fails closed ---
NOWS="${WORK}/nows"
mkdir -p "${NOWS}"
cat > "${NOWS}/tsconfig.json" <<'JSON'
{ "files": [], "references": [] }
JSON
assert_exit "missing pnpm-workspace.yaml fails" 1 env ROOT_DIR="${NOWS}" bash "${CHECK}"

NOTS="${WORK}/nots"
write_workspace "${NOTS}"
assert_exit "missing root tsconfig.json fails" 1 env ROOT_DIR="${NOTS}" bash "${CHECK}"

assert_exit "verify-gates registers the tsconfig references gate" 0 \
  grep -Fq 'bash scripts/gates/check-tsconfig-references.sh' "${SCRIPT_DIR}/../verify-gates.sh"

gate_test_finish
