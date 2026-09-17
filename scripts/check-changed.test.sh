#!/usr/bin/env bash
# Unit tests for check-changed.sh's own concerns (#review): the test-only
# selector-root overrides must not leak in from a caller's environment, and
# --help must print its full usage block.
# Run: bash scripts/check-changed.test.sh
set -uo pipefail
# git exports these when it runs a hook (this suite may run from the
# pre-commit hook itself), and they override `git -C`, so the throwaway
# decoy repo below would resolve back into the real repo's .git.
#
# TODO(fix/selftest-git-env): once that branch merges, replace the array
# above `unset` with `source "$(dirname "${BASH_SOURCE[0]}")/git-env.sh"` —
# the `unset "${GIT_HOOK_ENV_VARS[@]}"` line stays as-is, a two-line swap.
GIT_HOOK_ENV_VARS=(
  GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_PREFIX
)
unset "${GIT_HOOK_ENV_VARS[@]}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/gate-test-lib.sh"
CHECK_CHANGED="${SCRIPT_DIR}/check-changed.sh"
echo "=== check-changed.sh tests ==="

# --- --help prints the whole header, including the last usage line ---
# A fixed `sed -n '2,25p'` truncated silently when the header grew past line
# 25; the range must track the header's real end instead.
assert_output_contains "--help prints the CHECK_CHANGED_RANGE usage line" \
  'CHECK_CHANGED_RANGE=origin/main...HEAD bash scripts/check-changed.sh' \
  bash "${CHECK_CHANGED}" --help

# --- Neither ROOT_DIR nor SELECT_CHANGED_ROOT leaks in from the caller ---
DECOY="$(mktemp -d)"
trap 'rm -rf "${DECOY}"' EXIT
mkdir -p "${DECOY}/packages/decoy-only/src"
cat > "${DECOY}/packages/decoy-only/package.json" <<'JSON'
{
  "name": "@kinesin/decoy-only",
  "scripts": { "lint": "true", "typecheck": "true", "test": "true" }
}
JSON
printf 'export const d = 1\n' > "${DECOY}/packages/decoy-only/src/d.ts"
git -C "${DECOY}" init -q
git -C "${DECOY}" config user.email "decoy@test.local"
git -C "${DECOY}" config user.name "decoy"
git -C "${DECOY}" add .
git -C "${DECOY}" commit -qm "decoy base"
printf 'export const d = 2\n' >> "${DECOY}/packages/decoy-only/src/d.ts"
git -C "${DECOY}" add packages/decoy-only/src/d.ts
git -C "${DECOY}" commit -qm "touch decoy"

assert_output_lacks "SELECT_CHANGED_ROOT export cannot steer check-changed.sh onto a decoy repo" \
  "packages/decoy-only" \
  env SELECT_CHANGED_ROOT="${DECOY}" CHECK_CHANGED_RANGE="HEAD~1...HEAD" bash "${CHECK_CHANGED}" --dry-run
assert_output_lacks "ROOT_DIR export cannot steer check-changed.sh onto a decoy repo" \
  "packages/decoy-only" \
  env ROOT_DIR="${DECOY}" CHECK_CHANGED_RANGE="HEAD~1...HEAD" bash "${CHECK_CHANGED}" --dry-run

gate_test_finish
