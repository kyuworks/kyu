#!/usr/bin/env bash
# Unit tests for select-changed-checks.mjs (#30, #55, #60).
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

# Kills the command after 20 s, so a selector that loops on a sourcing cycle fails instead of hanging.
with_deadline() {
  node -e 'const r = require("node:child_process").spawnSync(process.argv[1], process.argv.slice(2), { stdio: "inherit", timeout: 20000 }); process.exit(r.status ?? 124)' "$@"
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

printf "import { shared } from \"./shared-reader.mjs\"\n" > "${REPO}/scripts/gates/check-double.mjs"
printf '#!/usr/bin/env bash\necho double-selftest\n' > "${REPO}/scripts/gates/check-double.test.sh"
git -C "${REPO}" add scripts/gates
git -C "${REPO}" commit -qm "add a gate that imports with double quotes"
printf '// touched again\n' >> "${REPO}/scripts/gates/shared-reader.mjs"
git -C "${REPO}" add scripts/gates/shared-reader.mjs
git -C "${REPO}" commit -qm "touch shared reader again"
assert_output_contains "a shared gate module selects a gate that imports it in double quotes" \
  "selftest:scripts/gates/check-double.test.sh" run_select "${REPO}" "HEAD~1...HEAD"

# --- A sourced shell helper with no suite of its own selects the suite of each script that sources it (#55) ---
mkdir -p "${REPO}/.agents/skills/demo" "${REPO}/infra/demo"
printf '# helper\nHELPER=1\n' > "${REPO}/scripts/lib/helper.sh"
printf '#!/usr/bin/env bash\nsource "${SCRIPT_DIR}/../lib/helper.sh"\n' > "${REPO}/scripts/gates/check-sourcer.sh"
printf '#!/usr/bin/env bash\necho sourcer-selftest\n' > "${REPO}/scripts/gates/check-sourcer.test.sh"
printf '#!/usr/bin/env bash\nsource "$(dirname "${BASH_SOURCE[0]}")/../lib/helper.sh"\n' > "${REPO}/scripts/gates/check-direct.test.sh"
printf '#!/usr/bin/env bash\n  . "${DIR}/scripts/lib/helper.sh"; echo dot\n' > "${REPO}/.agents/skills/demo/run.test.sh"
printf '#!/usr/bin/env bash\nsource ../../scripts/lib/helper.sh\n' > "${REPO}/infra/demo/deploy.test.sh"
printf '#!/usr/bin/env bash\n# must source scripts/lib/helper.sh\necho "does not source scripts/lib/helper.sh"\nsource "${D}/other-helper.sh"\n' > "${REPO}/scripts/gates/check-mention.sh"
printf '#!/usr/bin/env bash\necho mention-selftest\n' > "${REPO}/scripts/gates/check-mention.test.sh"
printf '#!/usr/bin/env bash\nsource "${D}/helper.sh"\n' > "${REPO}/scripts/gates/check-nosuite.sh"
git -C "${REPO}" add -A
git -C "${REPO}" commit -qm "add a sourced helper"
printf '# touched\n' >> "${REPO}/scripts/lib/helper.sh"
git -C "${REPO}" add scripts/lib/helper.sh
git -C "${REPO}" commit -qm "touch the helper"
for suite in scripts/gates/check-sourcer.test.sh scripts/gates/check-direct.test.sh .agents/skills/demo/run.test.sh infra/demo/deploy.test.sh; do
  assert_output_contains "a changed sourced helper selects ${suite}" \
    $'selftest:'"${suite}"$'\tbash scripts/lib/run-isolated-selftest.sh '"${suite}" run_select "${REPO}" "HEAD~1...HEAD"
done
assert_output_lacks "a script that only mentions the helper is not selected" \
  "check-mention" run_select "${REPO}" "HEAD~1...HEAD"
assert_output_lacks "a sourcing script with no suite adds no step" \
  "check-nosuite" run_select "${REPO}" "HEAD~1...HEAD"
assert_output_contains "a changed helper that a gate sources selects the gates" \
  $'gates\tbash scripts/verify-gates.sh' run_select "${REPO}" "HEAD~1...HEAD"

printf '#!/usr/bin/env bash\necho helper-selftest\n' > "${REPO}/scripts/lib/helper.test.sh"
printf '# touched again\n' >> "${REPO}/scripts/lib/helper.sh"
git -C "${REPO}" add scripts/lib
git -C "${REPO}" commit -qm "give the helper its own suite"
assert_output_contains "a helper with its own suite selects that suite" \
  "selftest:scripts/lib/helper.test.sh" run_select "${REPO}" "HEAD~1...HEAD"
assert_output_lacks "a helper with its own suite does not also select its sourcers" \
  "check-sourcer" run_select "${REPO}" "HEAD~1...HEAD"

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

# --- Every way a script sources a helper selects that script's suite (#60) ---
FORMS="${WORK}/forms"
init_fixture "${FORMS}"
mkdir -p "${FORMS}/infra/forms" "${FORMS}/infra/chain" "${FORMS}/infra/loop" "${FORMS}/.agents/skills/demo"
printf '# target\n' > "${FORMS}/scripts/lib/target.sh"
# form <name> <line>: infra/forms/<name>.sh holds the line, and <name>.test.sh is its suite.
form() {
  printf '#!/usr/bin/env bash\n%s\n' "$2" > "${FORMS}/infra/forms/$1.sh"
  printf '#!/usr/bin/env bash\necho %s\n' "$1" > "${FORMS}/infra/forms/$1.test.sh"
}
form after-and-source 'cd /tmp && source "${D}/target.sh"'
form after-and-dot '[ -f x ] && . "${D}/target.sh"'
form after-or 'false || source "${D}/target.sh"'
form after-semicolon 'true; source "${D}/target.sh"'
form in-subshell '(source ${D}/target.sh)'
form in-function 'load() { source "${D}/target.sh"; }'
form after-if 'if source "${D}/target.sh"; then :; fi'
form after-then 'if true; then source "${D}/target.sh"; fi'
form after-else 'if false; then :; else source "${D}/target.sh"; fi'
form after-elif 'if false; then :; elif source "${D}/target.sh"; then :; fi'
form after-do 'for d in x; do source "${d}/target.sh"; done'
form before-or 'source "${D}/target.sh"||exit'
form before-and 'source ${D}/target.sh&&true'
form before-redirect-out 'source ${D}/target.sh>/dev/null'
form before-redirect-in 'source ${D}/target.sh</dev/null'
form before-space 'source "${D}/target.sh" --quiet'
printf '#!/usr/bin/env bash\nsource "${D}/target.sh"' > "${FORMS}/infra/forms/at-file-end.sh"
printf '#!/usr/bin/env bash\necho at-file-end\n' > "${FORMS}/infra/forms/at-file-end.test.sh"
form other-suffix 'source "${D}/target.sh.bak"'
form other-dot 'source "${D}/targetxsh"'
form other-prefix 'source "${D}/mytarget.sh"'
form other-run 'cd /tmp && ./target.sh'
# inner.sh is sourced by outer.sh, which has no suite and is sourced by infra/chain/run.sh.
printf '# inner\n' > "${FORMS}/scripts/lib/inner.sh"
printf 'source "${D}/inner.sh"\n' > "${FORMS}/scripts/lib/outer.sh"
printf '#!/usr/bin/env bash\nsource "${D}/outer.sh"\n' > "${FORMS}/infra/chain/run.sh"
printf '#!/usr/bin/env bash\necho chain\n' > "${FORMS}/infra/chain/run.test.sh"
# loop-a.sh and loop-b.sh source each other.
printf 'source "${D}/loop-b.sh"\n' > "${FORMS}/scripts/lib/loop-a.sh"
printf 'source "${D}/loop-a.sh"\n' > "${FORMS}/scripts/lib/loop-b.sh"
printf '#!/usr/bin/env bash\nsource "${D}/loop-b.sh"\n' > "${FORMS}/infra/loop/use.sh"
printf '#!/usr/bin/env bash\necho loop\n' > "${FORMS}/infra/loop/use.test.sh"
# A helper outside scripts/lib, like .agents/skills/_pipeline/scripts/resolve-base.sh.
printf '# resolve\n' > "${FORMS}/.agents/skills/demo/resolve.sh"
printf '#!/usr/bin/env bash\nsource "${D}/resolve.sh"\n' > "${FORMS}/.agents/skills/demo/use.sh"
printf '#!/usr/bin/env bash\necho demo\n' > "${FORMS}/.agents/skills/demo/use.test.sh"
git -C "${FORMS}" add -A
git -C "${FORMS}" commit -qm "add sourcing forms"

printf '# touched\n' >> "${FORMS}/scripts/lib/target.sh"
git -C "${FORMS}" add -A
git -C "${FORMS}" commit -qm "touch target"
for name in after-and-source after-and-dot after-or after-semicolon in-subshell in-function after-if after-then \
  after-else after-elif after-do before-or before-and before-redirect-out before-redirect-in before-space at-file-end; do
  assert_output_contains "a changed helper selects the suite of a script that sources it: ${name}" \
    "selftest:infra/forms/${name}.test.sh" run_select "${FORMS}" "HEAD~1...HEAD"
done
for name in other-suffix other-dot other-prefix other-run; do
  assert_output_lacks "a changed helper does not select a script that sources another file: ${name}" \
    "selftest:infra/forms/${name}.test.sh" run_select "${FORMS}" "HEAD~1...HEAD"
done
assert_output_lacks "a changed helper that no gate sources does not select the gates" \
  "gates" run_select "${FORMS}" "HEAD~1...HEAD"

printf '# touched\n' >> "${FORMS}/scripts/lib/inner.sh"
git -C "${FORMS}" add -A
git -C "${FORMS}" commit -qm "touch inner"
assert_output_contains "a helper sourced through another helper selects the outer script's suite" \
  "selftest:infra/chain/run.test.sh" run_select "${FORMS}" "HEAD~1...HEAD"

printf '# touched\n' >> "${FORMS}/scripts/lib/loop-a.sh"
git -C "${FORMS}" add -A
git -C "${FORMS}" commit -qm "touch loop-a"
assert_output_contains "two helpers that source each other end the search and select the suite" \
  "selftest:infra/loop/use.test.sh" with_deadline env SELECT_CHANGED_ROOT="${FORMS}" CHECK_CHANGED_RANGE="HEAD~1...HEAD" node "${SELECTOR}"

printf '# touched\n' >> "${FORMS}/.agents/skills/demo/resolve.sh"
git -C "${FORMS}" add -A
git -C "${FORMS}" commit -qm "touch resolve"
assert_output_contains "a helper outside scripts/lib selects the suite of the script that sources it" \
  "selftest:.agents/skills/demo/use.test.sh" run_select "${FORMS}" "HEAD~1...HEAD"

# --- Rules that no other test pins: a case arm, non-.sh files, and each gate file kind (#60) ---
PINS="${WORK}/pins"
init_fixture "${PINS}"
mkdir -p "${PINS}/infra/pins" "${PINS}/.github/workflows"
printf '# pinned\n' > "${PINS}/scripts/lib/pinned.sh"
printf '#!/usr/bin/env bash\ncase "$1" in\n  x) source "${D}/pinned.sh" ;;\nesac\n' > "${PINS}/infra/pins/arm.sh"
printf '#!/usr/bin/env bash\necho arm\n' > "${PINS}/infra/pins/arm.test.sh"
printf 'source "${D}/pinned.sh"\n' > "${PINS}/infra/pins/notes.txt"
printf '#!/usr/bin/env bash\n' > "${PINS}/scripts/verify-gates.sh"
printf 'name: ci\n' > "${PINS}/.github/workflows/ci.yml"
git -C "${PINS}" add -A
git -C "${PINS}" commit -qm "add pins"
printf '# touched\n' >> "${PINS}/scripts/lib/pinned.sh"
git -C "${PINS}" add -A
git -C "${PINS}" commit -qm "touch pinned"
assert_output_contains "a source after a case arm selects the suite of the script that sources it" \
  "selftest:infra/pins/arm.test.sh" run_select "${PINS}" "HEAD~1...HEAD"
assert_output_lacks "a file that is not a .sh file is not read as a sourcer" \
  "infra/pins/notes.txt" run_select "${PINS}" "HEAD~1...HEAD"
printf '# touched\n' >> "${PINS}/scripts/verify-gates.sh"
git -C "${PINS}" add -A
git -C "${PINS}" commit -qm "touch verify-gates"
assert_output_contains "a change to verify-gates.sh selects the gates" \
  $'gates\tbash scripts/verify-gates.sh' run_select "${PINS}" "HEAD~1...HEAD"
printf '# touched\n' >> "${PINS}/.github/workflows/ci.yml"
git -C "${PINS}" add -A
git -C "${PINS}" commit -qm "touch workflow"
assert_output_contains "a change to a workflow file selects the gates" \
  $'gates\tbash scripts/verify-gates.sh' run_select "${PINS}" "HEAD~1...HEAD"

# --- A path the selector cannot read is skipped in one plain line; a tree it cannot list fails (#60) ---
ODD="${WORK}/odd"
init_fixture "${ODD}"
mkdir -p "${ODD}/scripts/gates" "${ODD}/infra"
printf '# odd\n' > "${ODD}/scripts/lib/odd.sh"
printf '#!/usr/bin/env bash\nsource "${D}/odd.sh"\n' > "${ODD}/scripts/gates/check-odd.sh"
printf '#!/usr/bin/env bash\necho odd\n' > "${ODD}/scripts/gates/check-odd.test.sh"
git -C "${ODD}" add -A
git -C "${ODD}" commit -qm "add odd helper"
printf '# touched\n' >> "${ODD}/scripts/lib/odd.sh"
git -C "${ODD}" add -A
git -C "${ODD}" commit -qm "touch odd helper"
ln -s missing.sh "${ODD}/scripts/gates/dangling.sh"
mkdir "${ODD}/infra/dir.sh"
mkfifo "${ODD}/infra/pipe.sh"
ln -s loop-b.sh "${ODD}/infra/loop-a.sh"
ln -s loop-a.sh "${ODD}/infra/loop-b.sh"
printf 'source odd.sh\n' > "${ODD}/infra/locked.sh"
chmod 000 "${ODD}/infra/locked.sh"
assert_exit "a dangling symlink, a directory, a named pipe, a link loop and an unreadable file do not stop the selector" 0 \
  with_deadline env SELECT_CHANGED_ROOT="${ODD}" CHECK_CHANGED_RANGE="HEAD~1...HEAD" node "${SELECTOR}"
assert_last_output_contains "the selector still selects the real sourcer next to odd paths" \
  "selftest:scripts/gates/check-odd.test.sh"
assert_last_output_contains "a dangling symlink is skipped in one plain line" \
  "select-changed-checks: skipped scripts/gates/dangling.sh (ENOENT)"
assert_last_output_contains "a directory named x.sh is skipped in one plain line" \
  "select-changed-checks: skipped infra/dir.sh (EISDIR)"
assert_last_output_contains "a named pipe is skipped in one plain line" \
  "select-changed-checks: skipped infra/pipe.sh (ENOTREG)"
assert_last_output_contains "a symlink loop is skipped in one plain line" \
  "select-changed-checks: skipped infra/loop-a.sh (ELOOP)"
# root reads every file and lists every directory, so these two cases only exist for other users.
if [ "$(id -u)" -ne 0 ]; then
  assert_last_output_contains "an unreadable file is skipped in one plain line" \
    "select-changed-checks: skipped infra/locked.sh (EACCES)"
  mkdir "${ODD}/infra/sealed"
  chmod 000 "${ODD}/infra/sealed"
  assert_exit "a directory the selector cannot list fails the selector" 1 run_select "${ODD}" "HEAD~1...HEAD"
  assert_last_output_contains "a directory the selector cannot list fails in one plain line" \
    "FAILED: select-changed-checks cannot list infra: EACCES"
  assert_output_lacks "a directory the selector cannot list prints no stack trace" \
    "    at " run_select "${ODD}" "HEAD~1...HEAD"
  chmod 755 "${ODD}/infra/sealed"
fi
chmod 644 "${ODD}/infra/locked.sh"

gate_test_finish
