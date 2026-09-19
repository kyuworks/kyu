#!/usr/bin/env bash
# Unit tests for red2-worktree.sh's preflight.
# Run: bash .agents/skills/_pipeline/scripts/red2-worktree.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# git exports these when it runs a hook, and they override the repository the
# script would otherwise find.
# shellcheck source=../../../../scripts/lib/git-env.sh
source "${SCRIPT_DIR}/../../../../scripts/lib/git-env.sh"
unset "${GIT_HOOK_ENV_VARS[@]}"

source "${SCRIPT_DIR}/../../../../scripts/lib/gate-test-lib.sh"
RED2="${SCRIPT_DIR}/red2-worktree.sh"

# Every case names a base that cannot resolve, so the script always stops well
# before it would build a worktree or run a suite.
preflight() {
  bash "${RED2}" --cmd "$1" --base red2-test-no-such-base
}

REJECTED="is not a script in the root package.json"

rejection_from() {
  preflight "$1" 2>&1 | grep -F "${REJECTED}" | head -1
}

echo "=== red2-worktree preflight tests ==="

assert_output_contains "a bare pnpm script that exists nowhere is rejected" \
  "${REJECTED}" preflight "pnpm no-such-script-anywhere"

# A leading flag is not a script name. -F is the short form of --filter, which
# the usage block tells the operator to use.
assert_eq "the short form of --filter is not read as a script name" "" \
  "$(rejection_from "pnpm -F @kyuworks/sdk test")"

# The hint must point at a package that exists in this workspace.
assert_output_contains "the rejection names the sdk package filter" \
  "pnpm --filter @kyuworks/sdk" preflight "pnpm no-such-script-anywhere"

assert_eq "a recursive run is not read as a script name" "" \
  "$(rejection_from "pnpm -r run test")"

gate_test_finish
