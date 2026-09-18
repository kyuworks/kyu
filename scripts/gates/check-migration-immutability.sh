#!/usr/bin/env bash
# check-migration-immutability.sh — refuse edits to a migration that already
# existed on the base SHA (ADR 20260916-outbox-migrations-are-immutable).
#
# ARMED=0: disarmed until the first consumer applies a migration to a real
# database. Issue #59 tracks re-arming.
#
# When ARMED=0 the gate prints SKIP and exits 0.
# When ARMED=1, a content change, rename, or delete of a packages/sdk/migrations/*.sql
# that existed on the merge-base of BASE and HEAD fails. New files pass.
# Mid-merge, a content change matching the blob at MERGE_HEAD is the incoming
# side's own history, not an edit by this merge, so it passes.
# BASE_SHA unset with no origin/main: fail closed.
#
# Env:
#   ROOT_DIR        default: repo root
#   MIGRATIONS_DIR  default: <root>/packages/sdk/migrations
#   BASE_SHA        git SHA/ref of the already-applied history
#   GITHUB_BASE_SHA fallback when BASE_SHA is unset (CI Lint job)
#   MIGRATION_IMMUTABILITY_ARMED  override ARMED (tests)
#
# Usage:
#   ./scripts/gates/check-migration-immutability.sh
#   MIGRATION_IMMUTABILITY_ARMED=1 BASE_SHA=<sha> bash scripts/gates/check-migration-immutability.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${ROOT_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-${ROOT_DIR}/packages/sdk/migrations}"

# Default 0 until #59 re-arms; tests set it explicitly.
ARMED=0
ARMED="${MIGRATION_IMMUTABILITY_ARMED:-${ARMED}}"

echo "=== migration immutability gate ==="

if [ "${ARMED}" != "1" ]; then
  echo "SKIP: migration immutability is disarmed (ARMED=${ARMED})."
  echo "Arm when a consumer has applied a file to a real database."
  exit 0
fi

echo "Armed. Migrations: ${MIGRATIONS_DIR}"

# Unset GIT_DIR/GIT_WORK_TREE so a hook export cannot retarget git.
# Do not name a path GIT_DIR — git reads that variable itself.
git_in_root() {
  env -u GIT_DIR -u GIT_WORK_TREE git -C "${ROOT_DIR}" "$@"
}

if ! git_in_root rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FAIL: ${ROOT_DIR} is not a git work tree." >&2
  exit 1
fi

BASE="${BASE_SHA:-${GITHUB_BASE_SHA:-}}"
if [ -z "${BASE}" ]; then
  if git_in_root rev-parse --verify "origin/main^{commit}" >/dev/null 2>&1; then
    BASE="$(git_in_root rev-parse --verify "origin/main^{commit}")"
    echo "BASE_SHA unset — using origin/main."
  else
    echo "FAIL: armed immutability needs BASE_SHA, GITHUB_BASE_SHA, or origin/main." >&2
    exit 1
  fi
fi

MIGRATIONS_REL="${MIGRATIONS_DIR}"
case "${MIGRATIONS_DIR}" in
  "${ROOT_DIR}"/*) MIGRATIONS_REL="${MIGRATIONS_DIR#"${ROOT_DIR}"/}" ;;
esac

if ! git_in_root rev-parse --verify "${BASE}^{commit}" >/dev/null 2>&1; then
  echo "FAIL: BASE_SHA ${BASE} is not a commit in this repository." >&2
  exit 1
fi

DIFF_ERR="$(mktemp)"
trap 'rm -f "${DIFF_ERR}"' EXIT
# Two-dot `git diff BASE` treats a migration added on BASE after this
# branch diverged as a delete. Compare the merge-base instead.
set +e
COMPARE="$(git_in_root merge-base "${BASE}" HEAD 2>"${DIFF_ERR}")"
MB_RC=$?
set -e
if [ "${MB_RC}" -ne 0 ] || [ -z "${COMPARE}" ]; then
  echo "FAIL: no merge-base between ${BASE} and HEAD." >&2
  if [ -s "${DIFF_ERR}" ]; then
    sed 's/^/  /' "${DIFF_ERR}" >&2
  fi
  exit 1
fi
if [ "${COMPARE}" != "$(git_in_root rev-parse --verify "${BASE}^{commit}")" ]; then
  echo "Comparing merge-base ${COMPARE} of BASE ${BASE} and HEAD."
fi

set +e
STATUS="$(git_in_root diff --name-status --find-renames --diff-filter=MDTR \
  "${COMPARE}" -- "${MIGRATIONS_REL}/*.sql" 2>"${DIFF_ERR}")"
DIFF_RC=$?
set -e
if [ "${DIFF_RC}" -ge 2 ]; then
  echo "FAIL: git diff of applied migrations failed (exit ${DIFF_RC})." >&2
  if [ -s "${DIFF_ERR}" ]; then
    sed 's/^/  /' "${DIFF_ERR}" >&2
  fi
  exit 1
fi

# A merge carries the incoming side's own history. A content change that
# matches the blob at MERGE_HEAD was made by a commit BASE already holds, not
# by this merge. Renames and deletes are never folded away.
if MERGE_HEAD_SHA="$(git_in_root rev-parse --verify --quiet MERGE_HEAD)"; then
  KEPT=""
  while IFS=$'\t' read -r code a b; do
    [ -z "${code}" ] && continue
    case "${code}" in
      [MT]*)
        if git_in_root diff --quiet "${MERGE_HEAD_SHA}" -- "${a}" 2>/dev/null; then
          continue
        fi
        ;;
    esac
    KEPT="${KEPT}${code}\t${a}\t${b}\n"
  done <<< "${STATUS}"
  FOLDED="${STATUS}"
  STATUS="$(printf '%b' "${KEPT}" | sed '/^$/d')"
  if [ -z "${STATUS}" ] && [ -n "${FOLDED}" ]; then
    echo "Merging ${MERGE_HEAD_SHA}: every flagged migration matches the incoming side."
  fi
fi

if [ -z "${STATUS}" ]; then
  echo "No applied migration was changed versus merge-base ${COMPARE}."
  echo "Migration immutability gate passed."
  exit 0
fi

echo "FAIL: applied migration(s) changed versus merge-base ${COMPARE}:" >&2
while IFS=$'\t' read -r code a b; do
  [ -z "${code}" ] && continue
  case "${code}" in
    R*)
      echo "  renamed ${a} -> ${b}" >&2
      ;;
    D*)
      echo "  deleted ${a}" >&2
      ;;
    *)
      echo "  ${code} ${a}" >&2
      ;;
  esac
done <<< "${STATUS}"
echo "Revert via a new migration. Do not edit or rename an applied file." >&2
exit 1
