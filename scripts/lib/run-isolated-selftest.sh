#!/usr/bin/env bash
# run-isolated-selftest.sh — route every out-of-band *.test.sh invocation
# (e.g. from scripts/check.sh) through here instead of a bare `bash <file>`,
# so the git hook env vars are cleared first (see scripts/lib/git-env.sh).
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
