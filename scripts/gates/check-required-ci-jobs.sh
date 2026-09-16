#!/usr/bin/env bash
# check-required-ci-jobs.sh — Required CI job names gate 
#
# Ensures GitHub Actions job display names in ci.yml match the canonical
# required-checks list. A rename, a dropped job, or a new job that is not
# added to required-checks.txt fails CI so required checks cannot drift.
#
# Fail conditions:
#   - CI_WORKFLOW or REQUIRED_CHECKS is missing
#   - required-checks.txt is empty after skipping blanks and # comments
#   - a required name is not a workflow job display name
#
# Extra jobs in ci.yml are allowed (nightly or reporting-only jobs).
#
# Env overrides (for tests):
#   CI_WORKFLOW      — path to a workflow yaml
#                      (default: <repo>/.github/workflows/ci.yml)
#   REQUIRED_CHECKS  — path to a required-checks list
#                      (default: <repo>/.github/workflows/required-checks.txt)
#
# Usage:
#   ./scripts/gates/check-required-ci-jobs.sh
#   CI_WORKFLOW=/tmp/ci.yml REQUIRED_CHECKS=/tmp/required.txt \
#     bash scripts/gates/check-required-ci-jobs.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CI_WORKFLOW="${CI_WORKFLOW:-${ROOT_DIR}/.github/workflows/ci.yml}"
REQUIRED_CHECKS="${REQUIRED_CHECKS:-${ROOT_DIR}/.github/workflows/required-checks.txt}"
for arg in "$@"; do
  echo "FAIL: unknown argument: ${arg}" >&2
  echo "Usage: $0" >&2
  exit 1
done

echo "=== Required CI Jobs Gate ==="
echo "Workflow: ${CI_WORKFLOW}"
echo "Required: ${REQUIRED_CHECKS}"

if [ ! -f "${CI_WORKFLOW}" ]; then
  echo "FAIL: Workflow file not found: ${CI_WORKFLOW}" >&2
  exit 1
fi

if [ ! -f "${REQUIRED_CHECKS}" ]; then
  echo "FAIL: Required checks file not found: ${REQUIRED_CHECKS}" >&2
  exit 1
fi

# Job display names: under jobs:, each `  foo:` key may have `    name: Display`.
# No name: → the job id is the check name. Ignore top-level `name: CI` and
# step/composite `name:` (those are more indented or under steps:).
parse_workflow_job_names() {
  awk '
    BEGIN { in_jobs = 0; job = ""; name = "" }

    function trim(s) {
      sub(/^[[:space:]]+/, "", s)
      sub(/[[:space:]]+$/, "", s)
      return s
    }

    function unquote(s) {
      if (length(s) >= 2 && substr(s, 1, 1) == "\"" && substr(s, length(s), 1) == "\"") {
        return substr(s, 2, length(s) - 2)
      }
      return s
    }

    function flush() {
      if (job == "") return
      if (name != "") print name
      else print job
      job = ""
      name = ""
    }

    /^jobs:[[:space:]]*$/ {
      flush()
      in_jobs = 1
      next
    }

    in_jobs && /^[^[:space:]#]/ {
      flush()
      in_jobs = 0
    }

    in_jobs && /^  [A-Za-z0-9_-]+:([[:space:]]*(#.*)?)?$/ {
      flush()
      job = $0
      sub(/^  /, "", job)
      sub(/:.*$/, "", job)
      next
    }

    in_jobs && /^    name:[[:space:]]*/ {
      if (name == "") {
        name = $0
        sub(/^    name:[[:space:]]*/, "", name)
        name = trim(unquote(trim(name)))
      }
      next
    }

    END { flush() }
  ' "$1"
}

workflow_names=$(parse_workflow_job_names "${CI_WORKFLOW}" | sed '/^$/d' | sort -u || true)
required_names=$(
  grep -vE '^[[:space:]]*(#|$)' "${REQUIRED_CHECKS}" \
    | sed 's/[[:space:]]*$//' \
    | sed '/^$/d' \
    | sort -u || true
)

if [ -z "${required_names}" ]; then
  echo "FAIL: Required checks list is empty: ${REQUIRED_CHECKS}" >&2
  exit 1
fi

echo ""
echo "Workflow jobs:"
echo "${workflow_names}" | sed 's/^/  - /'
echo ""
echo "Required checks:"
echo "${required_names}" | sed 's/^/  - /'

missing_from_wf=""
if [ -n "${workflow_names}" ]; then
  missing_from_wf=$(comm -23 <(printf '%s\n' "${required_names}") <(printf '%s\n' "${workflow_names}") || true)
else
  missing_from_wf="${required_names}"
fi

if [ -n "${missing_from_wf}" ]; then
  echo "" >&2
  echo "FAIL: required check(s) missing from ci.yml:" >&2
  echo "${missing_from_wf}" | sed 's/^/  - /' >&2
  echo "" >&2
  echo "Every name in ${REQUIRED_CHECKS} must be a job display name in ${CI_WORKFLOW}." >&2
  echo "See .github/workflows/REQUIRED.md." >&2
  exit 1
fi

echo ""
echo "Required job names are present in ci.yml."


exit 0
