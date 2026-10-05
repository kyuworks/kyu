#!/usr/bin/env bash
# check-changed.sh — the quiet local loop (`pnpm check:changed`).
#
# Reads the staged index (--staged), a Git range (CHECK_CHANGED_RANGE), or the
# working tree against origin/main, maps each changed path to the checks that
# own it, and runs those through scripts/check.sh. Silent on success. On
# failure: FAILED, the first error, and a log path under .artifacts/check/.
#
# Selection rules (scripts/lib/select-changed-checks.mjs):
#   packages/<p>/**, examples/<p>/**   lint, typecheck, typecheck:tests (when
#                            defined) and unit tests for <p> and every
#                            workspace package that depends on <p>, and the
#                            package boundaries gate
#   packages/sdk/migrations  migration immutability gate
#   <p>/package.json, packages/sdk/src/version.ts
#                            package versions and package exports gates
#   scripts/gates/*, scripts/verify-gates.sh, .github/workflows/*,
#   infra/hatchet/compose.yaml, infra/hatchet/fly/fly.toml
#                            every gate (they are cheap)
#   any *.sh or *.mjs        its colocated *.test.sh
#   scripts/gates/*.mjs with no *.test.sh
#                            the suite of each gate that imports it
#   *.sh with no *.test.sh   the suite of each script that sources it, directly
#                            or through another sourced file, and every gate
#                            when one of those scripts is a gate file
#   oxlint-rules/**          lint for every package
#   *.ts *.json *.css        format check on those files
#
# Exhaustive backstop: pnpm check.
#
# ROOT_DIR and SELECT_CHANGED_ROOT are test-only overrides read by the
# selector; both are stripped from this script's own environment before
# invoking it, so a caller's stray export cannot silently retarget the
# selector and select the wrong (or zero) checks.
#
# Usage:
#   bash scripts/check-changed.sh
#   bash scripts/check-changed.sh --staged
#   bash scripts/check-changed.sh --dry-run
#   CHECK_CHANGED_RANGE=origin/main...HEAD bash scripts/check-changed.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"
SELECTOR="${ROOT_DIR}/scripts/lib/select-changed-checks.mjs"
CHECK="${ROOT_DIR}/scripts/check.sh"

bash scripts/lib/check-node-engine.sh

DRY_RUN=0
ARGS=()
for arg in "$@"; do
  case "${arg}" in
    -h|--help)
      # From line 2 up to (not including) the first non-comment line, so the
      # header can grow without truncating --help. A fixed end line silently
      # dropped the last usage row before.
      sed -n '2,/^[^#]/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --dry-run) DRY_RUN=1 ;;
    --staged) ARGS+=("--staged") ;;
    *)
      echo "FAIL: unknown argument: ${arg}" >&2
      exit 2
      ;;
  esac
done

STEPS="$(env -u ROOT_DIR -u SELECT_CHANGED_ROOT node "${SELECTOR}" "${ARGS[@]+"${ARGS[@]}"}")"

if [ "${DRY_RUN}" -eq 1 ]; then
  if [ -z "${STEPS}" ]; then echo "(nothing selected)"; else printf '%s\n' "${STEPS}"; fi
  exit 0
fi

if [ -z "${STEPS}" ]; then
  [ "${CHECK_CHANGED_VERBOSE:-}" = "1" ] && echo "No changed files select a check."
  exit 0
fi

export CHECK_STEPS="${STEPS}"
exec bash "${CHECK}"
