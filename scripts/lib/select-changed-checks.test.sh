#!/usr/bin/env bash
# Unit tests for select-changed-checks.mjs (#30).
# Run: bash scripts/lib/select-changed-checks.test.sh
set -uo pipefail
# git exports these when it runs a hook (this suite may run from the
# pre-commit hook itself), and they override `git -C`, so the throwaway
# fixture repos below would resolve back into the real repo's .git.
source "$(dirname "${BASH_SOURCE[0]}")/git-env.sh"
unset "${GIT_HOOK_ENV_VARS[@]}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/gate-test-lib.sh"
SELECTOR="${SCRIPT_DIR}/select-changed-checks.mjs"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
echo "=== select-changed-checks tests ==="

init_fixture() {
  local root="$1"
  mkdir -p "${root}/packages/schemas/src" "${root}/packages/sdk/src" "${root}/examples/shop/src" \
    "${root}/packages/notests/src" "${root}/scripts/lib"
  cat > "${root}/packages/schemas/package.json" <<'JSON'
{
  "name": "@kyuworks/schemas",
  "scripts": { "lint": "true", "typecheck": "true", "typecheck:tests": "true", "test": "true" }
}
JSON
  cat > "${root}/packages/sdk/package.json" <<'JSON'
{
  "name": "@kyuworks/sdk",
  "dependencies": { "@kyuworks/schemas": "workspace:*" },
  "scripts": { "lint": "true", "typecheck": "true", "typecheck:tests": "true", "test": "true" }
}
JSON
  cat > "${root}/examples/shop/package.json" <<'JSON'
{
  "name": "@kyuworks/example-shop",
  "dependencies": { "@kyuworks/sdk": "workspace:*" },
  "scripts": { "lint": "true", "typecheck": "true", "typecheck:tests": "true", "test": "true" }
}
JSON
  # No typecheck:tests script: pins the guard that only emits that step when a
  # package actually defines it (a reviewer showed it can be reverted with a
  # green suite when nothing exercises a package missing the script).
  cat > "${root}/packages/notests/package.json" <<'JSON'
{
  "name": "@kyuworks/notests",
  "scripts": { "lint": "true", "typecheck": "true", "test": "true" }
}
JSON
  printf 'export const a = 1\n' > "${root}/packages/schemas/src/a.ts"
  printf 'export const b = 1\n' > "${root}/packages/sdk/src/b.ts"
  printf 'export const c = 1\n' > "${root}/examples/shop/src/c.ts"
  printf 'export const n = 1\n' > "${root}/packages/notests/src/n.ts"
  printf '// selector fixture\n' > "${root}/scripts/lib/select-changed-checks.mjs"
  printf '#!/usr/bin/env bash\necho fixture-selftest\n' > "${root}/scripts/lib/select-changed-checks.test.sh"
  git -C "${root}" init -q
  git -C "${root}" config user.email "select@test.local"
  git -C "${root}" config user.name "select"
  git -C "${root}" add .
  git -C "${root}" commit -qm "base"
}

run_select() {
  local root="$1" range="$2"
  env SELECT_CHANGED_ROOT="${root}" CHECK_CHANGED_RANGE="${range}" node "${SELECTOR}"
}

REPO="${WORK}/repo"
init_fixture "${REPO}"
REPO_BASE="$(git -C "${REPO}" rev-parse HEAD)"

# --- A change under examples/<name>/src selects that example's four steps ---
printf 'export const c = 2\n' >> "${REPO}/examples/shop/src/c.ts"
git -C "${REPO}" add examples/shop/src/c.ts
git -C "${REPO}" commit -qm "touch example"

assert_output_contains "example change selects lint" \
  $'lint:examples/shop\tpnpm --filter @kyuworks/example-shop lint' \
  run_select "${REPO}" "HEAD~1...HEAD"
assert_output_contains "example change selects typecheck" \
  $'typecheck:examples/shop\tpnpm --filter @kyuworks/example-shop typecheck' \
  run_select "${REPO}" "HEAD~1...HEAD"
assert_output_contains "example change selects typecheck:tests" \
  $'typecheck-tests:examples/shop\tpnpm --filter @kyuworks/example-shop typecheck:tests' \
  run_select "${REPO}" "HEAD~1...HEAD"
assert_output_contains "example change selects test" \
  $'test:examples/shop\tpnpm --filter @kyuworks/example-shop test' \
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
assert_output_contains "package change selects the package boundaries gate" \
  $'gate:package-boundaries\tbash scripts/gates/check-package-boundaries.sh' \
  run_select "${REPO}" "HEAD~1...HEAD"

# --- A change to a package pulls in the example that depends on it ---
assert_output_contains "sdk change pulls in the dependent example" \
  "lint:examples/shop" run_select "${REPO}" "HEAD~1...HEAD"

# --- A package with no typecheck:tests script does not get that step ---
printf 'export const n = 2\n' >> "${REPO}/packages/notests/src/n.ts"
git -C "${REPO}" add packages/notests/src/n.ts
git -C "${REPO}" commit -qm "touch notests"

assert_output_contains "notests change still selects lint" \
  "lint:packages/notests" run_select "${REPO}" "HEAD~1...HEAD"
assert_output_contains "notests change still selects typecheck" \
  "typecheck:packages/notests" run_select "${REPO}" "HEAD~1...HEAD"
assert_output_contains "notests change still selects test" \
  "test:packages/notests" run_select "${REPO}" "HEAD~1...HEAD"
assert_output_lacks "notests change does not select typecheck:tests (script undefined)" \
  "typecheck-tests:packages/notests" run_select "${REPO}" "HEAD~1...HEAD"

# --- A changed .mjs selects its own colocated self-test, same as a .sh ---
printf '// touched\n' >> "${REPO}/scripts/lib/select-changed-checks.mjs"
git -C "${REPO}" add scripts/lib/select-changed-checks.mjs
git -C "${REPO}" commit -qm "touch selector mjs"

assert_output_contains "changed .mjs selects its colocated .test.sh" \
  "selftest:scripts/lib/select-changed-checks.test.sh" \
  run_select "${REPO}" "HEAD~1...HEAD"

# --- A gate module with no suite of its own selects the suite of each gate that imports it ---
mkdir -p "${REPO}/scripts/gates"
printf 'export const shared = 1\n' > "${REPO}/scripts/gates/shared-reader.mjs"
printf "import { shared } from './shared-reader.mjs'\n" > "${REPO}/scripts/gates/check-user.mjs"
printf '#!/usr/bin/env bash\necho user-selftest\n' > "${REPO}/scripts/gates/check-user.test.sh"
printf '// imports nothing\n' > "${REPO}/scripts/gates/check-other.mjs"
printf '#!/usr/bin/env bash\necho other-selftest\n' > "${REPO}/scripts/gates/check-other.test.sh"
git -C "${REPO}" add scripts/gates
git -C "${REPO}" commit -qm "add gate modules"
printf '// touched\n' >> "${REPO}/scripts/gates/shared-reader.mjs"
git -C "${REPO}" add scripts/gates/shared-reader.mjs
git -C "${REPO}" commit -qm "touch shared reader"
assert_output_contains "a shared gate module selects the suite of the gate that imports it" \
  "selftest:scripts/gates/check-user.test.sh" run_select "${REPO}" "HEAD~1...HEAD"
assert_output_lacks "a shared gate module does not select a gate that does not import it" \
  "selftest:scripts/gates/check-other.test.sh" run_select "${REPO}" "HEAD~1...HEAD"

# --- A change to the engine image tag in compose or Fly selects the gates ---
for engine_file in infra/hatchet/compose.yaml infra/hatchet/fly/fly.toml; do
  mkdir -p "${REPO}/$(dirname "${engine_file}")"
  printf '# engine\n' >> "${REPO}/${engine_file}"
  git -C "${REPO}" add "${engine_file}"
  git -C "${REPO}" commit -qm "touch ${engine_file}"
  assert_output_contains "a ${engine_file} change selects the gates" \
    $'gates\tbash scripts/verify-gates.sh' \
    run_select "${REPO}" "HEAD~1...HEAD"
done

# --- SELECT_CHANGED_ROOT is the only override; a stray ROOT_DIR is inert
# (#review: renamed so a caller's own ROOT_DIR cannot silently retarget the
# selector at an unrelated directory and select nothing). An empty decoy repo
# stands in for "some other directory a caller happened to export ROOT_DIR
# for" — if the selector honored it, the fixture repo's steps below would not
# appear.
DECOY="${WORK}/decoy"
mkdir -p "${DECOY}"
git -C "${DECOY}" init -q
git -C "${DECOY}" config user.email "decoy@test.local"
git -C "${DECOY}" config user.name "decoy"
printf 'not a workspace\n' > "${DECOY}/README"
git -C "${DECOY}" add README
git -C "${DECOY}" commit -qm "decoy base"

assert_output_contains "SELECT_CHANGED_ROOT retargets the selector to the fixture repo" \
  "lint:packages/sdk" \
  env SELECT_CHANGED_ROOT="${REPO}" CHECK_CHANGED_RANGE="${REPO_BASE}...HEAD" node "${SELECTOR}"
assert_output_contains "a ROOT_DIR export alongside it does not override SELECT_CHANGED_ROOT" \
  "lint:packages/sdk" \
  env SELECT_CHANGED_ROOT="${REPO}" ROOT_DIR="${DECOY}" CHECK_CHANGED_RANGE="${REPO_BASE}...HEAD" node "${SELECTOR}"

# --- A package manifest change selects the package gates ---
MANIFEST="${WORK}/manifest"
init_fixture "${MANIFEST}"
printf '\n' >> "${MANIFEST}/packages/sdk/package.json"
git -C "${MANIFEST}" add packages/sdk/package.json
git -C "${MANIFEST}" commit -qm "touch sdk manifest"
assert_output_contains "manifest change selects the package versions gate" \
  "gate:package-versions" run_select "${MANIFEST}" "HEAD~1...HEAD"
assert_output_contains "manifest change selects the package exports gate" \
  "gate:package-exports" run_select "${MANIFEST}" "HEAD~1...HEAD"

gate_test_finish
