#!/usr/bin/env bash
# check-oidc-jobs-skip-cache.sh — jobs that can publish never touch the Actions cache.
#
# Any job on main can write a cache entry that a tag run restores, and
# `pnpm install --frozen-lockfile` trusts a restored node_modules. A job whose
# token can mint an OIDC token (id-token: write, or write-all) publishes, so it
# must not restore one.
#
# The rules are in check-oidc-jobs-skip-cache.mjs, which reads every workflow and
# action file with the `yaml` package and fails a file it and GitHub could read
# differently. The rule list is at the top of that file.
#
# Env overrides (for tests):
#   CI_WORKFLOWS_DIR — directory of workflow yaml files (default: <repo>/.github/workflows)
#   CI_ACTIONS_DIR   — directory searched for action.yml files (default: <repo>/.github/actions)
#
# Usage:
#   bash scripts/gates/check-oidc-jobs-skip-cache.sh
# Self-test: bash scripts/gates/check-oidc-jobs-skip-cache.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CI_WORKFLOWS_DIR="${CI_WORKFLOWS_DIR:-${ROOT_DIR}/.github/workflows}"
CI_ACTIONS_DIR="${CI_ACTIONS_DIR:-${ROOT_DIR}/.github/actions}"
for arg in "$@"; do
  echo "FAIL: unknown argument: ${arg}" >&2
  echo "Usage: $0" >&2
  exit 1
done

echo "=== OIDC jobs skip the Actions cache ==="

if [ ! -d "${CI_WORKFLOWS_DIR}" ]; then
  echo "FAIL: Workflows directory not found: ${CI_WORKFLOWS_DIR}" >&2
  exit 1
fi

if ! report="$(node "${SCRIPT_DIR}/check-oidc-jobs-skip-cache.mjs" "${CI_WORKFLOWS_DIR}" "${CI_ACTIONS_DIR}")"; then
  echo "FAIL: the workflow reader stopped before it checked every file; run pnpm install" >&2
  exit 1
fi

checked="$(sed -n 's/^CHECKED /  - /p' <<< "${report}")"
failures="$(sed -n '/^FAIL: /p' <<< "${report}")"

echo "Jobs with id-token: write:"
echo "${checked:-  (none)}"

if [ -n "${failures}" ]; then
  echo "" >&2
  echo "${failures}" >&2
  echo "" >&2
  echo "A job that can publish installs fresh, and a workflow that changes the release-age rule never writes the cache. See .github/workflows/REQUIRED.md." >&2
  exit 1
fi

echo "No job with id-token: write touches the Actions cache."
exit 0
