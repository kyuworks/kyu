#!/usr/bin/env bash
# Unit tests for check-migration-immutability.sh.
# Run: bash scripts/gates/check-migration-immutability.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# git exports these when it runs a hook, and they override `git -C`, so the
# throwaway repositories below would commit into the real one.
# shellcheck source=../lib/git-env.sh
source "${SCRIPT_DIR}/../lib/git-env.sh"
unset "${GIT_HOOK_ENV_VARS[@]}"

source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-migration-immutability.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

init_repo() {
  local root="$1"
  mkdir -p "${root}/packages/sdk/migrations"
  git -C "${root}" init -q
  git -C "${root}" config user.email "immut@test.local"
  git -C "${root}" config user.name "immut"
}

commit_base() {
  local root="$1"
  printf 'CREATE TABLE public.t (id uuid);\n' > "${root}/packages/sdk/migrations/20260101000000_base.sql"
  git -C "${root}" add packages/sdk/migrations/20260101000000_base.sql
  git -C "${root}" commit -qm "base"
  git -C "${root}" rev-parse HEAD
}

run_repo() {
  local root="$1"
  shift
  env ROOT_DIR="${root}" MIGRATIONS_DIR="${root}/packages/sdk/migrations" "$@" \
    bash -c "cd \"${root}\" && bash \"${CHECK}\""
}

echo "=== check-migration-immutability tests ==="

NOGIT="${WORK}/nogit"
mkdir -p "${NOGIT}/packages/sdk/migrations"
assert_exit "explicitly disarmed without git still passes" 0 \
  env ROOT_DIR="${NOGIT}" MIGRATIONS_DIR="${NOGIT}/packages/sdk/migrations" \
    MIGRATION_IMMUTABILITY_ARMED=0 bash "${CHECK}"
assert_output_contains "disarmed skip is visible" "SKIP" \
  env ROOT_DIR="${NOGIT}" MIGRATIONS_DIR="${NOGIT}/packages/sdk/migrations" \
    MIGRATION_IMMUTABILITY_ARMED=0 bash "${CHECK}"

EDIT="${WORK}/edit"
init_repo "${EDIT}"
EDIT_BASE="$(commit_base "${EDIT}")"
printf '%s\n' '-- folded' >> "${EDIT}/packages/sdk/migrations/20260101000000_base.sql"
assert_exit "explicitly disarmed still passes after an edit" 0 \
  run_repo "${EDIT}" MIGRATION_IMMUTABILITY_ARMED=0 BASE_SHA="${EDIT_BASE}"
assert_output_contains "disarmed edit still prints SKIP" "SKIP" \
  run_repo "${EDIT}" MIGRATION_IMMUTABILITY_ARMED=0 BASE_SHA="${EDIT_BASE}"
assert_exit "armed edit of an existing migration fails" 1 \
  run_repo "${EDIT}" MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA="${EDIT_BASE}"
assert_output_contains "armed edit names the file" "20260101000000_base.sql" \
  run_repo "${EDIT}" MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA="${EDIT_BASE}"
assert_exit "armed edit still fails with GIT_DIR exported" 1 \
  run_repo "${EDIT}" GIT_DIR=.git MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA="${EDIT_BASE}"

# Pins the default: armed. Re-armed under #89 after the migration was
# rewritten in place a second time.
assert_exit "unset ARMED defaults to armed on an edited migration" 1 \
  run_repo "${EDIT}" BASE_SHA="${EDIT_BASE}"
assert_output_contains "unset ARMED default prints FAIL" "FAIL" \
  run_repo "${EDIT}" BASE_SHA="${EDIT_BASE}"
assert_output_contains "unset ARMED default names the file" "20260101000000_base.sql" \
  run_repo "${EDIT}" BASE_SHA="${EDIT_BASE}"

CLEAN="${WORK}/clean"
init_repo "${CLEAN}"
CLEAN_BASE="$(commit_base "${CLEAN}")"
assert_exit "armed unchanged existing file passes" 0 \
  run_repo "${CLEAN}" MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA="${CLEAN_BASE}"
printf 'CREATE TABLE public.n (id uuid);\n' > "${CLEAN}/packages/sdk/migrations/20260101000001_new.sql"
git -C "${CLEAN}" add packages/sdk/migrations/20260101000001_new.sql
git -C "${CLEAN}" commit -qm "new"
assert_exit "armed new migration passes" 0 \
  run_repo "${CLEAN}" MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA="${CLEAN_BASE}"

DEL="${WORK}/delete"
init_repo "${DEL}"
DEL_BASE="$(commit_base "${DEL}")"
git -C "${DEL}" rm -q packages/sdk/migrations/20260101000000_base.sql
git -C "${DEL}" commit -qm "delete"
assert_exit "armed delete of an existing migration fails" 1 \
  run_repo "${DEL}" MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA="${DEL_BASE}"

REN="${WORK}/rename"
init_repo "${REN}"
REN_BASE="$(commit_base "${REN}")"
git -C "${REN}" mv packages/sdk/migrations/20260101000000_base.sql \
  packages/sdk/migrations/20260101000000_renamed.sql
git -C "${REN}" commit -qm "rename"
assert_exit "armed rename of an existing migration fails" 1 \
  run_repo "${REN}" MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA="${REN_BASE}"

UNSET="${WORK}/unset"
init_repo "${UNSET}"
commit_base "${UNSET}" >/dev/null
assert_exit "armed with BASE_SHA unset fails closed" 1 \
  run_repo "${UNSET}" MIGRATION_IMMUTABILITY_ARMED=1
assert_output_contains "armed no base says FAIL" "FAIL" \
  run_repo "${UNSET}" MIGRATION_IMMUTABILITY_ARMED=1

FALLBACK="${WORK}/fallback"
init_repo "${FALLBACK}"
FALLBACK_BASE="$(commit_base "${FALLBACK}")"
git -C "${FALLBACK}" update-ref refs/remotes/origin/main "${FALLBACK_BASE}"
printf '%s\n' '-- folded' >> "${FALLBACK}/packages/sdk/migrations/20260101000000_base.sql"
assert_exit "armed uses origin/main when BASE_SHA is unset" 1 \
  run_repo "${FALLBACK}" MIGRATION_IMMUTABILITY_ARMED=1
assert_output_contains "origin/main fallback names the file" "20260101000000_base.sql" \
  run_repo "${FALLBACK}" MIGRATION_IMMUTABILITY_ARMED=1

DIFFERR="${WORK}/differr"
init_repo "${DIFFERR}"
DIFFERR_BASE="$(commit_base "${DIFFERR}")"
assert_exit "armed git diff error fails closed" 1 \
  env ROOT_DIR="${DIFFERR}" MIGRATIONS_DIR="/tmp/kyu-no-migrations-$$" \
    MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA="${DIFFERR_BASE}" bash "${CHECK}"
assert_output_contains "armed git diff error says FAIL" "FAIL" \
  env ROOT_DIR="${DIFFERR}" MIGRATIONS_DIR="/tmp/kyu-no-migrations-$$" \
    MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA="${DIFFERR_BASE}" bash "${CHECK}"

assert_exit "current tree armed with no migration edits passes" 0 \
  env BASE_SHA=HEAD bash "${CHECK}"

STALE="${WORK}/stale"
init_repo "${STALE}"
STALE_ROOT="$(commit_base "${STALE}")"
git -C "${STALE}" branch -M develop
git -C "${STALE}" checkout -qb feature
printf 'unrelated\n' > "${STALE}/README"
git -C "${STALE}" add README
git -C "${STALE}" commit -qm "feature"
git -C "${STALE}" checkout -q develop
printf 'CREATE TABLE public.n (id uuid);\n' > "${STALE}/packages/sdk/migrations/20260101000001_later.sql"
git -C "${STALE}" add packages/sdk/migrations/20260101000001_later.sql
git -C "${STALE}" commit -qm "later on develop"
STALE_DEVELOP="$(git -C "${STALE}" rev-parse HEAD)"
git -C "${STALE}" checkout -q feature
assert_exit "armed ignores a migration added on BASE after the branch diverged" 0 \
  run_repo "${STALE}" MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA="${STALE_DEVELOP}"
printf '%s\n' '-- folded' >> "${STALE}/packages/sdk/migrations/20260101000000_base.sql"
assert_exit "armed still fails an edit of a merge-base migration when BASE has moved on" 1 \
  run_repo "${STALE}" MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA="${STALE_DEVELOP}"

MERGING="${WORK}/merging"
init_repo "${MERGING}"
commit_base "${MERGING}" >/dev/null
git -C "${MERGING}" branch -M develop
git -C "${MERGING}" checkout -qb feature
printf 'unrelated\n' > "${MERGING}/README"
git -C "${MERGING}" add README
git -C "${MERGING}" commit -qm "feature"
git -C "${MERGING}" checkout -q develop
printf '%s\n' '-- tightened on develop' >> "${MERGING}/packages/sdk/migrations/20260101000000_base.sql"
git -C "${MERGING}" add packages/sdk/migrations/20260101000000_base.sql
git -C "${MERGING}" commit -qm "edit on develop before the gate was armed"
MERGING_DEVELOP="$(git -C "${MERGING}" rev-parse HEAD)"
git -C "${MERGING}" checkout -q feature
git -C "${MERGING}" merge --no-commit --no-ff "${MERGING_DEVELOP}" >/dev/null 2>&1
assert_exit "armed folds away a merge-base edit that matches the incoming side" 0 \
  run_repo "${MERGING}" MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA="${MERGING_DEVELOP}"
printf '%s\n' '-- and edited by the merge' >> "${MERGING}/packages/sdk/migrations/20260101000000_base.sql"
assert_exit "armed still fails a mid-merge edit that matches neither side" 1 \
  run_repo "${MERGING}" MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA="${MERGING_DEVELOP}"
git -C "${MERGING}" checkout -q -- packages/sdk/migrations/20260101000000_base.sql
git -C "${MERGING}" rm -q -f packages/sdk/migrations/20260101000000_base.sql
assert_exit "armed still fails a mid-merge delete of an applied migration" 1 \
  run_repo "${MERGING}" MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA="${MERGING_DEVELOP}"

gate_test_finish
