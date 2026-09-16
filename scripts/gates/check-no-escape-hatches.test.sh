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
gate_test_finish
