#!/usr/bin/env bash
# Unit tests for detect-stage.sh.
# Run: bash .agents/skills/next/detect-stage.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# git exports these when it runs a hook, and they override `git -C`, so the
# throwaway repositories below would commit into the real one.
# shellcheck source=../../../scripts/lib/git-env.sh
source "${SCRIPT_DIR}/../../../scripts/lib/git-env.sh"
unset "${GIT_HOOK_ENV_VARS[@]}"

source "${SCRIPT_DIR}/../../../scripts/lib/gate-test-lib.sh"
DETECT="${SCRIPT_DIR}/detect-stage.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# One commit on local `main`, then two implementation commits on a scratch
# branch that stand in for origin/main being ahead of the local copy. Local
# main stays behind — the shape a fresh clone or a cloud session has after
# someone else merged. Only a lookup that prefers the remote-tracking ref
# measures a new branch correctly; a local-main lookup reports the two
# remote commits as the branch's own.
init_repo() {
  local root="$1"
  mkdir -p "${root}"
  printf 'base\n' > "${root}/README.md"
  git -C "${root}" init -q -b main
  git -C "${root}" config user.email "stage@test.local"
  git -C "${root}" config user.name "stage"
  git -C "${root}" add -A
  git -C "${root}" commit -qm "base"
  git -C "${root}" checkout -q -b scratch
  commit_file "${root}" "packages/sdk/src/ahead-one.ts" "ahead of local main 1"
  commit_file "${root}" "packages/sdk/src/ahead-two.ts" "ahead of local main 2"
}

commit_file() {
  local root="$1" file="$2" msg="$3"
  mkdir -p "${root}/$(dirname "${file}")"
  printf '%s\n' "// ${msg}" > "${root}/${file}"
  git -C "${root}" add "${file}"
  git -C "${root}" commit -qm "${msg}"
}

# Fake a fetched remote: origin/main at the tip, local main two behind,
# origin/HEAD pointing at main — as this checkout's does.
fake_remote() {
  local root="$1"
  git -C "${root}" update-ref refs/remotes/origin/main HEAD
  git -C "${root}" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
}

detect() {
  local root="$1"
  shift
  (cd "${root}" && bash "${DETECT}" "$@")
}

value() {
  local root="$1" key="$2"
  detect "${root}" | sed -n "s/^${key}=//p"
}

echo "=== detect-stage tests ==="

# --- base resolution ---
REMOTE="${WORK}/remote"
init_repo "${REMOTE}"
fake_remote "${REMOTE}"
git -C "${REMOTE}" checkout -q -b feat/empty
assert_eq "origin/main wins over a stale local main" "main" "$(value "${REMOTE}" BASE)"
assert_output_contains "the evidence says why" "BASE_SOURCE=origin/main exists" detect "${REMOTE}"

# A remote whose default branch is not called main: no origin/main, so
# origin/HEAD decides.
HEAD_ONLY="${WORK}/head-only"
init_repo "${HEAD_ONLY}"
git -C "${HEAD_ONLY}" update-ref refs/remotes/origin/trunk HEAD
git -C "${HEAD_ONLY}" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/trunk
git -C "${HEAD_ONLY}" checkout -q -b feat/head-only
assert_eq "no origin/main falls back to origin/HEAD" "trunk" "$(value "${HEAD_ONLY}" BASE)"

LOCAL="${WORK}/local"
init_repo "${LOCAL}"
git -C "${LOCAL}" checkout -q -b feat/local
assert_exit "no remote refs at all does not crash" 0 detect "${LOCAL}"
assert_eq "no remote refs falls back to local main" "main" "$(value "${LOCAL}" BASE)"
assert_output_contains "local fallback says so" "BASE_SOURCE=no remote refs; local main exists" detect "${LOCAL}"

# --- stage decisions against origin/main ---
# The regression: a brand-new branch off origin/main measured against a stale
# local main reported the two remote commits as its own and routed to verify.
assert_eq "an empty branch off origin/main is 0 ahead" "0" "$(value "${REMOTE}" COMMITS_AHEAD)"
assert_eq "an empty branch off origin/main is at plan" "plan" "$(value "${REMOTE}" STAGE)"

IMPL="${WORK}/impl"
init_repo "${IMPL}"
fake_remote "${IMPL}"
git -C "${IMPL}" checkout -q -b feat/impl
commit_file "${IMPL}" "packages/sdk/src/x.ts" "implementation"
assert_eq "one implementation commit is at verify" "verify" "$(value "${IMPL}" STAGE)"
assert_eq "one implementation commit is 1 ahead, not 3" "1" "$(value "${IMPL}" COMMITS_AHEAD)"

INFRA="${WORK}/infra"
init_repo "${INFRA}"
fake_remote "${INFRA}"
git -C "${INFRA}" checkout -q -b chore/infra
commit_file "${INFRA}" "infra/hatchet/compose.yaml" "hatchet config"
assert_eq "a chore/ branch yields a slug" "infra" "$(value "${INFRA}" SLUG)"
assert_eq "an infra/ commit counts as implementation" "yes" "$(value "${INFRA}" HAS_IMPL_COMMITS)"

# --- test-file recognition ---
TESTS="${WORK}/tests"
init_repo "${TESTS}"
fake_remote "${TESTS}"
git -C "${TESTS}" checkout -q -b feat/tests
commit_file "${TESTS}" "packages/sdk/src/outbox.test.ts" "unit test"
commit_file "${TESTS}" "packages/sdk/src/relay.integration.test.ts" "integration test"
commit_file "${TESTS}" "scripts/gates/check-thing.test.sh" "shell suite"
assert_eq "colocated vitest and shell suites are tests" "yes" "$(value "${TESTS}" HAS_TEST_COMMITS)"
assert_eq "test files alone are not implementation" "no" "$(value "${TESTS}" HAS_IMPL_COMMITS)"
assert_eq "tests without implementation is RED1 done, at build" "build" "$(value "${TESTS}" STAGE)"

# --- docs-only ---
DOCS="${WORK}/docs"
init_repo "${DOCS}"
fake_remote "${DOCS}"
git -C "${DOCS}" checkout -q -b feat/docs
commit_file "${DOCS}" "docs/architecture/adr/0001-note.md" "docs only"
commit_file "${DOCS}" "packages/sdk/README.md" "package readme"
assert_eq "docs/ and *.md commits are docs-only" "yes" "$(value "${DOCS}" DOCS_ONLY_COMMITS)"
assert_eq "a docs-only commit is still at plan" "plan" "$(value "${DOCS}" STAGE)"

# --- a branch whose changed-file list is larger than a pipe holds ---
# A test path sorts first and about 240 KB of paths follow: more than a pipe holds.
LARGE="${WORK}/large"
init_repo "${LARGE}"
fake_remote "${LARGE}"
git -C "${LARGE}" checkout -q -b feat/large
mkdir -p "${LARGE}/packages/a" "${LARGE}/packages/sdk/src/padding"
printf 'test\n' > "${LARGE}/packages/a/first.test.ts"
LARGE_PAD="$(printf '%0200d' 0)"
for i in $(seq -w 1 1000); do
  : > "${LARGE}/packages/sdk/src/padding/file-${LARGE_PAD}-${i}.ts"
done
git -C "${LARGE}" add -A
git -C "${LARGE}" commit -qm "large branch"
assert_eq "a test listed first on a large branch still counts" "yes" "$(value "${LARGE}" HAS_TEST_COMMITS)"
assert_eq "implementation after a test on a large branch still counts" "yes" "$(value "${LARGE}" HAS_IMPL_COMMITS)"
assert_eq "a large branch with code on it is not docs-only" "no" "$(value "${LARGE}" DOCS_ONLY_COMMITS)"
assert_eq "an implementation commit is not docs-only" "no" "$(value "${IMPL}" DOCS_ONLY_COMMITS)"

# --- unattended is read off the same variable the guard reads ---
assert_eq "a local session is attended" "no" \
  "$(cd "${REMOTE}" && env -u CLAUDE_CODE_REMOTE bash "${DETECT}" | sed -n 's/^UNATTENDED=//p')"
assert_eq "CLAUDE_CODE_REMOTE=true is unattended" "yes" \
  "$(cd "${REMOTE}" && env CLAUDE_CODE_REMOTE=true bash "${DETECT}" | sed -n 's/^UNATTENDED=//p')"

gate_test_finish
