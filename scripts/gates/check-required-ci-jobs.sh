#!/usr/bin/env bash
# check-required-ci-jobs.sh — Required CI job names gate
#
# Ensures every name in the canonical required-checks list is the check name of
# exactly one job, in a workflow that runs on pull_request, that GitHub cannot
# skip or leave out. A rename or a dropped job fails CI. Extra jobs are allowed.
#
# The rules are in check-required-ci-jobs.mjs, which reads every workflow with
# the `yaml` package (workflow-yaml.mjs) and fails a file it cannot read. The
# rule list is at the top of that file.
#
# Env overrides (for tests):
#   CI_WORKFLOWS_DIR — directory of workflow yaml files
#                      (default: <repo>/.github/workflows)
#   REQUIRED_CHECKS  — path to a required-checks list
#                      (default: <repo>/.github/workflows/required-checks.txt)
#
# Usage:
#   ./scripts/gates/check-required-ci-jobs.sh
# Self-test: bash scripts/gates/check-required-ci-jobs.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${SCRIPT_DIR}/../lib/require-yaml.sh"
CI_WORKFLOWS_DIR="${CI_WORKFLOWS_DIR:-${ROOT_DIR}/.github/workflows}"
REQUIRED_CHECKS="${REQUIRED_CHECKS:-${ROOT_DIR}/.github/workflows/required-checks.txt}"
for arg in "$@"; do
  echo "FAIL: unknown argument: ${arg}" >&2
  echo "Usage: $0" >&2
  exit 1
done

echo "=== Required CI Jobs Gate ==="
echo "Workflows: ${CI_WORKFLOWS_DIR}"
echo "Required: ${REQUIRED_CHECKS}"

if [ ! -d "${CI_WORKFLOWS_DIR}" ]; then
  echo "FAIL: Workflows directory not found: ${CI_WORKFLOWS_DIR}" >&2
  exit 1
fi

if [ ! -f "${REQUIRED_CHECKS}" ]; then
  echo "FAIL: Required checks file not found: ${REQUIRED_CHECKS}" >&2
  exit 1
fi

require_yaml_package "${SCRIPT_DIR}"
exec node "${SCRIPT_DIR}/check-required-ci-jobs.mjs" "${CI_WORKFLOWS_DIR}" "${REQUIRED_CHECKS}"
