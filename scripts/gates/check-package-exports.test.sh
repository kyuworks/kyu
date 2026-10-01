#!/usr/bin/env bash
# Unit tests for check-package-exports.sh.
# Run: bash scripts/gates/check-package-exports.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-package-exports.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
echo "=== check-package-exports tests ==="

# write_pkg root name files-json [extra-json]
write_pkg() {
  local root="$1" name="$2" files="$3" extra="${4:-}"
  mkdir -p "${root}/packages/${name}/dist"
  cat > "${root}/packages/${name}/package.json" <<JSON
{
  "name": "@fixture/${name}",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ${files}${extra}
}
JSON
}

# --- Entry points built and migrations listed -> pass ---
OK="${WORK}/ok"
write_pkg "${OK}" sdk '["dist", "migrations"]'
printf 'export {}\n' > "${OK}/packages/sdk/dist/index.js"
printf 'export {}\n' > "${OK}/packages/sdk/dist/index.d.ts"
mkdir -p "${OK}/packages/sdk/migrations"
printf 'select 1;\n' > "${OK}/packages/sdk/migrations/20260101000000_init.sql"
assert_exit "built package with its migrations passes" 0 env ROOT_DIR="${OK}" bash "${CHECK}"

# --- An exports target missing from dist -> fail ---
NODIST="${WORK}/nodist"
write_pkg "${NODIST}" schemas '["dist"]'
printf 'export {}\n' > "${NODIST}/packages/schemas/dist/index.js"
assert_exit "exports target missing from dist fails" 1 env ROOT_DIR="${NODIST}" bash "${CHECK}"
assert_last_output_contains "failure names the missing target" "./dist/index.d.ts"

# --- migrations/ left out of files -> fail ---
NOMIG="${WORK}/nomig"
write_pkg "${NOMIG}" sdk '["dist"]'
printf 'export {}\n' > "${NOMIG}/packages/sdk/dist/index.js"
printf 'export {}\n' > "${NOMIG}/packages/sdk/dist/index.d.ts"
mkdir -p "${NOMIG}/packages/sdk/migrations"
printf 'select 1;\n' > "${NOMIG}/packages/sdk/migrations/20260101000000_init.sql"
assert_exit "migrations left out of files fails" 1 env ROOT_DIR="${NOMIG}" bash "${CHECK}"
assert_last_output_contains "failure names the migration file" "migrations/20260101000000_init.sql"

# --- prepack builds dist before the check -> pass ---
BUILD="${WORK}/build"
write_pkg "${BUILD}" schemas '["dist"]' ',
  "scripts": { "prepack": "printf x > dist/index.js && printf x > dist/index.d.ts" }'
assert_exit "prepack output is in the tarball" 0 env ROOT_DIR="${BUILD}" bash "${CHECK}"

# --- a private package is not packed -> pass ---
PRIV="${WORK}/private"
write_pkg "${PRIV}" shop '["dist"]' ',
  "private": true'
assert_exit "private package is skipped" 0 env ROOT_DIR="${PRIV}" bash "${CHECK}"

assert_exit "verify-gates registers the package exports gate" 0 \
  grep -Fq 'bash scripts/gates/check-package-exports.sh' "${SCRIPT_DIR}/../verify-gates.sh"

gate_test_finish
