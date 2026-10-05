#!/usr/bin/env bash
# check-tsconfig-references.sh — every workspace package with a tsconfig.json
# is wired into the root tsconfig.json's `references`. `pnpm typecheck` is
# `tsc -b` over those references only, so a package left out is silently
# unchecked by CI's Type Check job.
#
# The rules are in check-tsconfig-references.mjs, which reads pnpm-workspace.yaml
# with the `yaml` package (workflow-yaml.mjs) and fails a file it cannot read.
#
# Env overrides (for tests):
#   ROOT_DIR          — repo root to scan (default: repo root)
#   WORKSPACE_FILE     — path to pnpm-workspace.yaml
#                        (default: <ROOT_DIR>/pnpm-workspace.yaml)
#   ROOT_TSCONFIG      — path to the root tsconfig.json
#                        (default: <ROOT_DIR>/tsconfig.json)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/require-yaml.sh"
ROOT_DIR="${ROOT_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
WORKSPACE_FILE="${WORKSPACE_FILE:-${ROOT_DIR}/pnpm-workspace.yaml}"
ROOT_TSCONFIG="${ROOT_TSCONFIG:-${ROOT_DIR}/tsconfig.json}"
cd "${ROOT_DIR}"
echo "=== tsconfig references ==="

if [ ! -f "${WORKSPACE_FILE}" ]; then
  echo "FAIL: workspace file not found: ${WORKSPACE_FILE}" >&2
  exit 1
fi
if [ ! -f "${ROOT_TSCONFIG}" ]; then
  echo "FAIL: root tsconfig not found: ${ROOT_TSCONFIG}" >&2
  exit 1
fi

require_yaml_package "${SCRIPT_DIR}"
exec node "${SCRIPT_DIR}/check-tsconfig-references.mjs" "${ROOT_DIR}" "${WORKSPACE_FILE}" "${ROOT_TSCONFIG}"
