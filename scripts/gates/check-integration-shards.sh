#!/usr/bin/env bash
# check-integration-shards.sh — every integration test file runs in exactly one
# CI shard. CI runs each suite as two jobs, KYU_INTEGRATION_SHARD=1 and =2; the
# split lives in the suite's vitest.integration.config.ts. This asks vitest which
# files each shard resolves, so a file in no shard or in both fails the PR.
#
# Env overrides (for tests):
#   ROOT_DIR        — repo root to scan (default: repo root)
#   SHARD_LIST_CMD  — prints one test file per line for the suite in the current
#                     directory and the shard in KYU_INTEGRATION_SHARD (default:
#                     pnpm exec vitest list --config vitest.integration.config.ts --filesOnly)
#
# Usage:
#   bash scripts/gates/check-integration-shards.sh
set -euo pipefail
export LC_ALL=C
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SHARD_LIST_CMD="${SHARD_LIST_CMD:-pnpm exec vitest list --config vitest.integration.config.ts --filesOnly}"
for arg in "$@"; do
  echo "FAIL: unknown argument: ${arg}" >&2
  exit 1
done
echo "=== Integration shards ==="

# $1 suite dir, $2 shard number or "all". Prints sorted integration files.
list_suite_files() {
  local out
  if [ "$2" = all ]; then
    out="$(cd "$1" && env -u KYU_INTEGRATION_SHARD ${SHARD_LIST_CMD})" || return 1
  else
    out="$(cd "$1" && KYU_INTEGRATION_SHARD="$2" ${SHARD_LIST_CMD})" || return 1
  fi
  printf '%s\n' "${out}" | { grep -E '\.integration\.test\.ts$' || true; } | sort -u
}

suites=0
failed=0
for config in "${ROOT_DIR}"/packages/*/vitest.integration.config.ts "${ROOT_DIR}"/examples/*/vitest.integration.config.ts; do
  [ -f "${config}" ] || continue
  dir="$(dirname "${config}")"
  rel="${dir#"${ROOT_DIR}"/}"
  suites=$((suites + 1))
  if ! all="$(list_suite_files "${dir}" all)" || ! one="$(list_suite_files "${dir}" 1)" \
    || ! two="$(list_suite_files "${dir}" 2)"; then
    echo "FAIL: ${rel}: vitest could not list the integration files" >&2
    failed=1
    continue
  fi
  problems="$(
    [ -n "${all}" ] || echo "the suite lists no integration files"
    [ -n "${one}" ] || echo "shard 1 runs no files"
    [ -n "${two}" ] || echo "shard 2 runs no files"
    comm -12 <(printf '%s\n' "${one}") <(printf '%s\n' "${two}") | sed '/^$/d; s/^/in both shards: /'
    comm -23 <(printf '%s\n' "${all}") <(printf '%s\n%s\n' "${one}" "${two}" | sort -u) | sed '/^$/d; s/^/in no shard: /'
  )"
  if [ -n "${problems}" ]; then
    echo "FAIL: ${rel}:" >&2
    printf '%s\n' "${problems}" | sed 's/^/  /' >&2
    failed=1
  else
    echo "${rel}: $(printf '%s\n' "${one}" | wc -l | tr -d ' ') + $(printf '%s\n' "${two}" | wc -l | tr -d ' ') files"
  fi
done

if [ "${suites}" -eq 0 ]; then
  echo "FAIL: no packages/*/ or examples/*/ vitest.integration.config.ts found under ${ROOT_DIR}" >&2
  exit 1
fi
if [ "${failed}" -ne 0 ]; then
  echo "Each file must run in exactly one shard. The shard-one list is in the suite's vitest.integration.config.ts." >&2
  exit 1
fi
echo "Every integration file runs in exactly one shard."
