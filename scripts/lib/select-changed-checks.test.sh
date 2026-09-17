#!/usr/bin/env bash
# Unit tests for select-changed-checks.mjs (#30).
# Run: bash scripts/lib/select-changed-checks.test.sh
set -uo pipefail
# git exports these when it runs a hook (this suite may run from the
# pre-commit hook itself), and they override `git -C`, so the throwaway
# fixture repos below would resolve back into the real repo's .git.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_PREFIX
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/gate-test-lib.sh"
SELECTOR="${SCRIPT_DIR}/select-changed-checks.mjs"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
echo "=== select-changed-checks tests ==="

init_fixture() {
  local root="$1"
  mkdir -p "${root}/packages/schemas/src" "${root}/packages/sdk/src" "${root}/examples/playground/src"
  cat > "${root}/packages/schemas/package.json" <<'JSON'
{
  "name": "@kinesin/schemas",
  "scripts": { "lint": "true", "typecheck": "true", "typecheck:tests": "true", "test": "true" }
}
JSON
  cat > "${root}/packages/sdk/package.json" <<'JSON'
{
  "name": "@kinesin/sdk",
  "dependencies": { "@kinesin/schemas": "workspace:*" },
  "scripts": { "lint": "true", "typecheck": "true", "typecheck:tests": "true", "test": "true" }
}
JSON
  cat > "${root}/examples/playground/package.json" <<'JSON'
{
  "name": "@kinesin/example-playground",
  "dependencies": { "@kinesin/sdk": "workspace:*" },
  "scripts": { "lint": "true", "typecheck": "true", "typecheck:tests": "true", "test": "true" }
}
JSON
  printf 'export const a = 1\n' > "${root}/packages/schemas/src/a.ts"
  printf 'export const b = 1\n' > "${root}/packages/sdk/src/b.ts"
  printf 'export const c = 1\n' > "${root}/examples/playground/src/c.ts"
  git -C "${root}" init -q
  git -C "${root}" config user.email "select@test.local"
  git -C "${root}" config user.name "select"
  git -C "${root}" add .
  git -C "${root}" commit -qm "base"
}

run_select() {
  local root="$1" range="$2"
  env ROOT_DIR="${root}" CHECK_CHANGED_RANGE="${range}" node "${SELECTOR}"
}

REPO="${WORK}/repo"
init_fixture "${REPO}"

# --- A change under examples/<name>/src selects that example's four steps ---
printf 'export const c = 2\n' >> "${REPO}/examples/playground/src/c.ts"
git -C "${REPO}" add examples/playground/src/c.ts
git -C "${REPO}" commit -qm "touch example"

assert_output_contains "example change selects lint" \
  $'lint:examples/playground\tpnpm --filter @kinesin/example-playground lint' \
  run_select "${REPO}" "HEAD~1...HEAD"
assert_output_contains "example change selects typecheck" \
  $'typecheck:examples/playground\tpnpm --filter @kinesin/example-playground typecheck' \
  run_select "${REPO}" "HEAD~1...HEAD"
assert_output_contains "example change selects typecheck:tests" \
  $'typecheck-tests:examples/playground\tpnpm --filter @kinesin/example-playground typecheck:tests' \
  run_select "${REPO}" "HEAD~1...HEAD"
assert_output_contains "example change selects test" \
  $'test:examples/playground\tpnpm --filter @kinesin/example-playground test' \
  run_select "${REPO}" "HEAD~1...HEAD"
assert_output_lacks "example change does not select an unrelated package" \
  "packages/schemas" \
  run_select "${REPO}" "HEAD~1...HEAD"

# --- A change under packages/<name>/src still selects that package's four steps ---
printf 'export const b = 2\n' >> "${REPO}/packages/sdk/src/b.ts"
git -C "${REPO}" add packages/sdk/src/b.ts
git -C "${REPO}" commit -qm "touch sdk"

assert_output_contains "package change selects lint" \
  "lint:packages/sdk" run_select "${REPO}" "HEAD~1...HEAD"
assert_output_contains "package change selects typecheck" \
  "typecheck:packages/sdk" run_select "${REPO}" "HEAD~1...HEAD"
assert_output_contains "package change selects typecheck:tests" \
  "typecheck-tests:packages/sdk" run_select "${REPO}" "HEAD~1...HEAD"
assert_output_contains "package change selects test" \
  "test:packages/sdk" run_select "${REPO}" "HEAD~1...HEAD"

# --- A change to a package pulls in the example that depends on it ---
assert_output_contains "sdk change pulls in the dependent example" \
  "lint:examples/playground" run_select "${REPO}" "HEAD~1...HEAD"

gate_test_finish
