#!/usr/bin/env bash
# Unit tests for check-pr-size.sh
# Run: bash scripts/gates/check-pr-size.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# git exports these when it runs a hook, and they override `git -C`, so the
# throwaway repositories below would commit into the real one.
# shellcheck source=../lib/git-env.sh
source "${SCRIPT_DIR}/../lib/git-env.sh"
unset "${GIT_HOOK_ENV_VARS[@]}"

source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-pr-size.sh"

# Cases set the hatch explicitly. A hatch exported by the caller (for
# example a pre-commit run using it for one PR) must not leak into a case
# that expects the gate to fail.
# GITHUB_BASE_REF is live in the Gate Self Tests job; the moved-base case sets it itself.
unset PR_SIZE_LABELS PR_SIZE_BODY GITHUB_BASE_REF

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

init_repo() {
  local root="$1"
  mkdir -p "${root}/apps/api/src"
  git -C "${root}" init -q
  git -C "${root}" config user.email "pr-size@test.local"
  git -C "${root}" config user.name "pr-size"
  printf '%s\n' "export const ok = 1" > "${root}/apps/api/src/ok.ts"
  git -C "${root}" add .
  git -C "${root}" commit -qm "base"
}

run_check() {
  local root="$1"
  shift
  env ROOT_DIR="${root}" PR_SIZE_MAX="${PR_SIZE_MAX:-5}" \
    PR_SIZE_LABELS="${PR_SIZE_LABELS:-}" \
    PR_SIZE_BODY="${PR_SIZE_BODY-}" \
    bash "${CHECK}" "$@"
}

add_lines() {
  local path="$1" n="$2"
  local i
  : > "${path}"
  for i in $(seq 1 "${n}"); do
    printf 'line %s\n' "${i}" >> "${path}"
  done
}

echo "=== check-pr-size tests ==="

REPO="${WORK}/under"
mkdir -p "${REPO}"
init_repo "${REPO}"
add_lines "${REPO}/apps/api/src/small.ts" 4
git -C "${REPO}" add apps/api/src/small.ts
git -C "${REPO}" commit -qm "small"
assert_exit "net additions under the limit -> pass" 0 \
  run_check "${REPO}" --range HEAD~1
assert_output_contains "under-limit prints OK" "OK: production PR size" \
  run_check "${REPO}" --range HEAD~1

REPO="${WORK}/over"
mkdir -p "${REPO}"
init_repo "${REPO}"
add_lines "${REPO}/apps/api/src/big.ts" 8
git -C "${REPO}" add apps/api/src/big.ts
git -C "${REPO}" commit -qm "big"
assert_exit "net additions over the limit -> fail" 1 \
  run_check "${REPO}" --range HEAD~1
assert_output_contains "over-limit names the file" "apps/api/src/big.ts" \
  run_check "${REPO}" --range HEAD~1
assert_output_contains "over-limit names the hatch" "oversized-justified:" \
  run_check "${REPO}" --range HEAD~1

REPO="${WORK}/delete"
mkdir -p "${REPO}"
init_repo "${REPO}"
add_lines "${REPO}/apps/api/src/old.ts" 40
git -C "${REPO}" add apps/api/src/old.ts
git -C "${REPO}" commit -qm "old"
rm "${REPO}/apps/api/src/old.ts"
printf '%s\n' "export const kept = 1" > "${REPO}/apps/api/src/kept.ts"
git -C "${REPO}" add -A
git -C "${REPO}" commit -qm "shrink"
assert_exit "large delete with a small add -> pass" 0 \
  run_check "${REPO}" --range HEAD~1

REPO="${WORK}/excluded"
mkdir -p "${REPO}/apps/api/src/__generated__" \
  "${REPO}/apps/api/src/__tests__" \
  "${REPO}/scripts/gates/fixtures" \
  "${REPO}/docs"
init_repo "${REPO}"
add_lines "${REPO}/apps/api/src/__generated__/types.ts" 20
add_lines "${REPO}/pnpm-lock.yaml" 20
add_lines "${REPO}/scripts/gates/fixtures/sample.ts" 20
add_lines "${REPO}/apps/api/src/__tests__/wide.test.ts" 20
add_lines "${REPO}/README.md" 20
git -C "${REPO}" add .
git -C "${REPO}" commit -qm "excluded bulk"
assert_exit "generated lockfile fixture test markdown -> pass" 0 \
  run_check "${REPO}" --range HEAD~1

REPO="${WORK}/label-only"
mkdir -p "${REPO}"
init_repo "${REPO}"
add_lines "${REPO}/apps/api/src/big.ts" 8
git -C "${REPO}" add apps/api/src/big.ts
git -C "${REPO}" commit -qm "big"
assert_exit "oversize with label only -> fail" 1 \
  env ROOT_DIR="${REPO}" PR_SIZE_MAX=5 \
    PR_SIZE_LABELS="oversized-justified" PR_SIZE_BODY="" \
    bash "${CHECK}" --range HEAD~1

REPO="${WORK}/reason-only"
mkdir -p "${REPO}"
init_repo "${REPO}"
add_lines "${REPO}/apps/api/src/big.ts" 8
git -C "${REPO}" add apps/api/src/big.ts
git -C "${REPO}" commit -qm "big"
assert_exit "oversize with reason only -> fail" 1 \
  env ROOT_DIR="${REPO}" PR_SIZE_MAX=5 PR_SIZE_LABELS="" \
    PR_SIZE_BODY="oversized-justified: mechanical codegen after the SDL change" \
    bash "${CHECK}" --range HEAD~1

REPO="${WORK}/hatch"
mkdir -p "${REPO}"
init_repo "${REPO}"
add_lines "${REPO}/apps/api/src/big.ts" 8
git -C "${REPO}" add apps/api/src/big.ts
git -C "${REPO}" commit -qm "big"
assert_exit "oversize with label and reason -> pass" 0 \
  env ROOT_DIR="${REPO}" PR_SIZE_MAX=5 \
    PR_SIZE_LABELS="oversized-justified" \
    PR_SIZE_BODY="oversized-justified: mechanical codegen after the SDL change" \
    bash "${CHECK}" --range HEAD~1

EVENT="${WORK}/event.json"
printf '%s\n' '{"pull_request":{"labels":[{"name":"oversized-justified"}],"body":"oversized-justified: mechanical codegen after the SDL change\n"}}' \
  > "${EVENT}"
REPO="${WORK}/event"
mkdir -p "${REPO}"
init_repo "${REPO}"
add_lines "${REPO}/apps/api/src/big.ts" 8
git -C "${REPO}" add apps/api/src/big.ts
git -C "${REPO}" commit -qm "big"
assert_exit "oversize with GITHUB_EVENT_PATH hatch -> pass" 0 \
  env ROOT_DIR="${REPO}" PR_SIZE_MAX=5 GITHUB_EVENT_PATH="${EVENT}" \
    bash "${CHECK}" --range HEAD~1

EVENT_LEAK="${WORK}/event-leak.json"
printf '%s\n' '{"pull_request":{"labels":[{"name":"oversized-justified"}],"body":""}}' \
  > "${EVENT_LEAK}"
REPO="${WORK}/event-leak"
mkdir -p "${REPO}"
init_repo "${REPO}"
add_lines "${REPO}/apps/api/src/big.ts" 8
git -C "${REPO}" add apps/api/src/big.ts
git -C "${REPO}" commit -qm "big"
assert_exit "event label ignored when PR_SIZE_BODY is set -> fail" 1 \
  env ROOT_DIR="${REPO}" PR_SIZE_MAX=5 GITHUB_EVENT_PATH="${EVENT_LEAK}" \
    PR_SIZE_LABELS="" \
    PR_SIZE_BODY="oversized-justified: mechanical codegen after the SDL change" \
    bash "${CHECK}" --range HEAD~1

# CI checks out the merge ref and passes the base sha the pull request event
# recorded. Once the base branch moves, that sha is behind, and three dots from
# it count the base branch's own commits as well.
REPO="${WORK}/moved-base"
mkdir -p "${REPO}"
init_repo "${REPO}"
MOVED_BASE_SHA="$(git -C "${REPO}" rev-parse HEAD)"
git -C "${REPO}" checkout -q -b pr-branch
add_lines "${REPO}/apps/api/src/small.ts" 4
git -C "${REPO}" add apps/api/src/small.ts
git -C "${REPO}" commit -qm "pull request change"
MOVED_PR_SHA="$(git -C "${REPO}" rev-parse HEAD)"
git -C "${REPO}" checkout -q "${MOVED_BASE_SHA}"
add_lines "${REPO}/apps/api/src/sibling.ts" 8
git -C "${REPO}" add apps/api/src/sibling.ts
git -C "${REPO}" commit -qm "a sibling pull request lands on the base branch"
git -C "${REPO}" update-ref refs/remotes/origin/main HEAD
git -C "${REPO}" merge -q --no-ff -m "merge ref" "${MOVED_PR_SHA}"

# $1 is the limit. The range is the one the Lint job builds from the event.
moved_base_check() {
  env ROOT_DIR="${REPO}" PR_SIZE_MAX="$1" PR_SIZE_LABELS="" PR_SIZE_BODY="" \
    GITHUB_BASE_REF=main GITHUB_BASE_SHA="${MOVED_BASE_SHA}" \
    bash "${CHECK}" --range "${MOVED_BASE_SHA}...HEAD"
}

assert_exit "base branch moved after the pull request opened -> pass" 0 \
  moved_base_check 5
assert_output_contains "moved base counts only the pull request's own lines" \
  "production +4 −0 (net 4)" moved_base_check 5
assert_exit "moved base still fails a pull request that is itself too big" 1 \
  moved_base_check 3
assert_last_output_contains "the over-limit report names the pull request's file" \
  "apps/api/src/small.ts"
assert_output_lacks "the over-limit report leaves out the base branch's file" \
  "apps/api/src/sibling.ts" moved_base_check 3

git -C "${REPO}" update-ref -d refs/remotes/origin/main
assert_output_contains "merge ref with no fetched base branch uses its first parent" \
  "production +4 −0 (net 4)" moved_base_check 5

assert_exit "verify-gates registers the production PR size gate" 0 \
  grep -Fq 'bash scripts/gates/check-pr-size.sh' "${ROOT_DIR}/scripts/verify-gates.sh"

gate_test_finish
