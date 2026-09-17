#!/usr/bin/env bash
# run-isolated-selftest.sh — run one *.test.sh with the git hook env vars
# cleared first (see scripts/lib/git-env.sh).
#
# scripts/lib/select-changed-checks.mjs emits a `selftest:<file>` step for
# any changed *.sh with a colocated *.test.sh, and scripts/check.sh runs
# that step's command directly, bypassing the cleanup that
# scripts/verify-self-tests.sh does for every other suite. A suite that
# builds a throwaway git repository under mktemp would then resolve `git -C`
# back into the real repository when the step runs from inside
# .husky/pre-commit. Route every out-of-band *.test.sh invocation through
# here instead of a bare `bash <file>`.
#
# Usage:
#   bash scripts/lib/run-isolated-selftest.sh <path to *.test.sh>
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "FAIL: usage: run-isolated-selftest.sh <path to *.test.sh>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./git-env.sh
source "${SCRIPT_DIR}/git-env.sh"
unset "${GIT_HOOK_ENV_VARS[@]}"

exec bash "$1"
