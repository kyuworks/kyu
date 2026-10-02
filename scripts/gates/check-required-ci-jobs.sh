#!/usr/bin/env bash
# check-required-ci-jobs.sh — Required CI job names gate 
#
# Ensures every name in the canonical required-checks list is a job display
# name in a workflow that runs on pull_request. A rename or a dropped job
# fails CI so required checks cannot drift from the ruleset.
#
# Fail conditions:
#   - CI_WORKFLOWS_DIR or REQUIRED_CHECKS is missing
#   - required-checks.txt is empty after skipping blanks and # comments
#   - a required name is not a job display name in any pull-request workflow
#
# A workflow counts when its top-level on: names pull_request, as a scalar,
# a flow list, or a key. Tag-only and pull_request_target workflows do not.
# Extra jobs are allowed (nightly or reporting-only jobs).
#
# Env overrides (for tests):
#   CI_WORKFLOWS_DIR — directory of workflow yaml files
#                      (default: <repo>/.github/workflows)
#   REQUIRED_CHECKS  — path to a required-checks list
#                      (default: <repo>/.github/workflows/required-checks.txt)
#
# Usage:
#   ./scripts/gates/check-required-ci-jobs.sh
#   CI_WORKFLOWS_DIR=/tmp/workflows REQUIRED_CHECKS=/tmp/required.txt \
#     bash scripts/gates/check-required-ci-jobs.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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

# Exit 0 when the top-level on: names pull_request: `on: pull_request`,
# `on: [push, pull_request]`, or a `pull_request:` key / `- pull_request` item
# that is a direct child of on: (not nested under another trigger).
workflow_has_pull_request_trigger() {
  awk '
    BEGIN { in_on = 0; found = 0; child = -1 }

    /^(on|"on"):/ {
      in_on = 1
      rest = $0
      sub(/^[^:]*:/, "", rest)
      sub(/#.*$/, "", rest)
      if (rest ~ /(^|[^A-Za-z0-9_-])pull_request([^A-Za-z0-9_-]|$)/) found = 1
      next
    }

    in_on && /^[^[:space:]#]/ { in_on = 0 }

    in_on && /^[[:space:]]+[^[:space:]#]/ {
      match($0, /^[[:space:]]+/)
      if (child < 0) child = RLENGTH
      if (RLENGTH == child && $0 ~ /^[[:space:]]+(-[[:space:]]+)?pull_request[[:space:]]*(:.*)?(#.*)?$/) found = 1
    }

    END { exit(found ? 0 : 1) }
  ' "$1"
}

pull_request_workflows() {
  local wf
  for wf in "${CI_WORKFLOWS_DIR}"/*.yml "${CI_WORKFLOWS_DIR}"/*.yaml; do
    [ -f "${wf}" ] || continue
    if workflow_has_pull_request_trigger "${wf}"; then
      printf '%s\n' "${wf}"
    fi
  done
}

pr_workflows="$(pull_request_workflows)"
workflow_names=""
if [ -n "${pr_workflows}" ]; then
  workflow_names=$(
    while IFS= read -r wf; do
      parse_workflow_job_names "${wf}"
    done <<< "${pr_workflows}" | sed '/^$/d' | sort -u || true
  )
fi
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
echo "Pull-request workflows:"
echo "${pr_workflows}" | sed 's/^/  - /'
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
  echo "FAIL: required check(s) missing from every pull-request workflow:" >&2
  echo "${missing_from_wf}" | sed 's/^/  - /' >&2
  echo "" >&2
  echo "Every name in ${REQUIRED_CHECKS} must be a job display name in a workflow under ${CI_WORKFLOWS_DIR} that runs on pull_request." >&2
  echo "See .github/workflows/REQUIRED.md." >&2
  exit 1
fi

echo ""
echo "Required job names are present in pull-request workflows."


exit 0
