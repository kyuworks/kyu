#!/usr/bin/env bash
# Run: bash scripts/gates/check-no-escape-hatches.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-no-escape-hatches.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
echo "=== check-no-escape-hatches tests ==="
mkdir -p "${WORK}/clean/packages/a/src"
printf 'export const a = 1\n' > "${WORK}/clean/packages/a/src/a.ts"
printf 'const x = 1 as any\n' > "${WORK}/clean/packages/a/src/a.test.ts"
assert_exit "clean source passes; test files are exempt" 0 env ROOT_DIR="${WORK}/clean" bash "${CHECK}"
mkdir -p "${WORK}/dirty/packages/b/src"
printf '// @ts-ignore\nexport const b = 1 as unknown as string\n' > "${WORK}/dirty/packages/b/src/b.ts"
assert_exit "as unknown as / ts-ignore in source fails" 1 env ROOT_DIR="${WORK}/dirty" bash "${CHECK}"
assert_output_contains "failure names the file" "packages/b/src/b.ts" env ROOT_DIR="${WORK}/dirty" bash "${CHECK}"

mkdir -p "${WORK}/example-clean/examples/shop/src"
printf 'export const a = 1\n' > "${WORK}/example-clean/examples/shop/src/a.ts"
printf 'const x = 1 as any\n' > "${WORK}/example-clean/examples/shop/src/a.test.ts"
assert_exit "clean example source passes; test files are exempt" 0 env ROOT_DIR="${WORK}/example-clean" bash "${CHECK}"

mkdir -p "${WORK}/example-dirty/examples/shop/src"
printf '// @ts-ignore\nexport const b = 1 as unknown as string\n' > "${WORK}/example-dirty/examples/shop/src/b.ts"
assert_exit "escape hatch in example source fails" 1 env ROOT_DIR="${WORK}/example-dirty" bash "${CHECK}"
assert_output_contains "failure names the example file" "examples/shop/src/b.ts" env ROOT_DIR="${WORK}/example-dirty" bash "${CHECK}"

# --- A package-root file (vitest config/setup, not under src) is scanned too (#review) ---
mkdir -p "${WORK}/example-root-dirty/examples/shop/src"
printf 'export const a = 1\n' > "${WORK}/example-root-dirty/examples/shop/src/a.ts"
printf '// @ts-ignore\nexport const b = 1 as unknown as string\n' > "${WORK}/example-root-dirty/examples/shop/vitest.integration.setup.ts"
assert_exit "escape hatch in an example's package-root file fails" 1 \
  env ROOT_DIR="${WORK}/example-root-dirty" bash "${CHECK}"
assert_output_contains "failure names the package-root file" \
  "examples/shop/vitest.integration.setup.ts" \
  env ROOT_DIR="${WORK}/example-root-dirty" bash "${CHECK}"

# --- A .cts file is scanned like a .ts file (#45) ---
mkdir -p "${WORK}/cts-dirty/packages/c/src"
printf 'const c = 1 as any\nmodule.exports = { c }\n' > "${WORK}/cts-dirty/packages/c/src/c.cts"
assert_exit "escape hatch in a .cts source file fails" 1 env ROOT_DIR="${WORK}/cts-dirty" bash "${CHECK}"
assert_output_contains "failure names the .cts file" "packages/c/src/c.cts" env ROOT_DIR="${WORK}/cts-dirty" bash "${CHECK}"

mkdir -p "${WORK}/cts-example-dirty/examples/shop/src"
printf 'const a = 1 as any\nmodule.exports = { a }\n' > "${WORK}/cts-example-dirty/examples/shop/src/x.cts"
assert_exit "escape hatch in an example .cts file fails" 1 env ROOT_DIR="${WORK}/cts-example-dirty" bash "${CHECK}"
assert_output_contains "failure names the example .cts file" "examples/shop/src/x.cts" env ROOT_DIR="${WORK}/cts-example-dirty" bash "${CHECK}"

gate_test_finish
