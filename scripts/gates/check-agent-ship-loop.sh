#!/usr/bin/env bash
# check-agent-ship-loop.sh — agent PR ship-loop checklist (#1974).
#
# Humans may omit the section. Agents may not claim Ready without a
# completed one. verify-gates.sh runs it when PR_BODY_FILE is set;
# ship-loop.yml runs it on every pull request.
#
# Self-test: bash scripts/gates/check-agent-ship-loop.test.sh
#
# Usage:
#   bash scripts/gates/check-agent-ship-loop.sh --body FILE
#   bash scripts/gates/check-agent-ship-loop.sh --body FILE --agent
#   bash scripts/gates/check-agent-ship-loop.sh --body FILE --behavior-changed
#   bash scripts/gates/check-agent-ship-loop.sh --body FILE --author LOGIN --branch NAME
set -euo pipefail

BODY=""
AGENT=0
BEHAVIOR_CHANGED=0
AUTHOR=""
BRANCH=""

usage() {
  echo "Usage: $0 --body FILE [--agent] [--behavior-changed] [--author LOGIN] [--branch NAME]" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --body)
      BODY="${2:-}"
      shift 2
      ;;
    --agent)
      AGENT=1
      shift
      ;;
    --behavior-changed)
      BEHAVIOR_CHANGED=1
      shift
      ;;
    --author)
      AUTHOR="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      ;;
    *)
      echo "FAIL: unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [ -z "${BODY}" ]; then
  echo "FAIL: --body FILE is required" >&2
  usage
fi

if [ "${BODY}" = "-" ]; then
  BODY_TEXT="$(cat)"
elif [ -f "${BODY}" ]; then
  BODY_TEXT="$(cat "${BODY}")"
else
  echo "FAIL: body file not found: ${BODY}" >&2
  exit 1
fi

echo "=== Agent ship loop ==="

is_agent_author() {
  case "${AUTHOR}" in
    'cursor[bot]'|cursoragent) return 0 ;;
    *) return 1 ;;
  esac
}

# Here-strings, not pipes: awk's exit and grep -q stop reading early and break the writer under pipefail.
SECTION="$(awk '
  BEGIN { ign = 0 }
  /^##[ \t]+[Aa]gent[ \t]+ship[ \t]+loop/ { ign = 1; next }
  ign && /^##[ \t]/ { exit }
  ign { print }
' <<< "${BODY_TEXT}")"

HAS_HEADING=0
if [ -n "${SECTION}" ] || grep -Eq '^##[ \t]+[Aa]gent[ \t]+ship[ \t]+loop' <<< "${BODY_TEXT}"; then
  HAS_HEADING=1
fi

CHECKED_COUNT="$(printf '%s\n' "${SECTION}" | grep -cE '^[[:space:]]*[-*][[:space:]]*\[[xX]\]' || true)"

IS_AGENT=0
if [ "${AGENT}" -eq 1 ]; then
  IS_AGENT=1
fi
if [[ "${BRANCH}" == cursor/* ]]; then
  IS_AGENT=1
fi
if is_agent_author; then
  IS_AGENT=1
fi
if [ "${HAS_HEADING}" -eq 1 ] && [ "${CHECKED_COUNT}" -gt 0 ]; then
  IS_AGENT=1
fi

if [ "${IS_AGENT}" -eq 0 ]; then
  echo "PASS: no agent ship loop required (human shortcut)."
  exit 0
fi

if [ "${HAS_HEADING}" -eq 0 ]; then
  echo "FAIL: agent PR missing ## Agent ship loop. Agents fill that section. Humans delete it." >&2
  exit 1
fi

fail_item() {
  echo "FAIL: agent ship loop item not checked: $1" >&2
  exit 1
}

# A checked line contains needle (case-insensitive).
checked_has() {
  local needle="$1"
  printf '%s\n' "${SECTION}" | grep -iE '^[[:space:]]*[-*][[:space:]]*\[[xX]\].*'"${needle}" >/dev/null
}

checked_has Plan || fail_item "Plan"
checked_has 'must-hold' || fail_item "Red must-hold"
checked_has Smallest || fail_item "Smallest diff"
checked_has 'check:changed' || fail_item "pnpm check:changed"
checked_has 'Separate review' || fail_item "Separate review"
checked_has 'Hosted CI' || fail_item "Hosted CI"

behavior_line="$(printf '%s\n' "${SECTION}" | grep -iE '^[[:space:]]*Behavior changed:' | head -1 || true)"
proof_line="$(printf '%s\n' "${SECTION}" | grep -iE '^[[:space:]]*Red proof:' | head -1 || true)"

if [ -z "${behavior_line}" ]; then
  echo "FAIL: agent ship loop must declare Behavior changed: yes or no." >&2
  exit 1
fi

behavior_value="$(printf '%s\n' "${behavior_line}" | sed -E 's/^[^:]*:[[:space:]]*//' | tr '[:upper:]' '[:lower:]' | awk '{print $1}')"

if [ "${behavior_value}" != "yes" ] && [ "${behavior_value}" != "no" ]; then
  echo "FAIL: Behavior changed must be yes or no." >&2
  exit 1
fi

if [ "${behavior_value}" = "yes" ]; then
  BEHAVIOR_CHANGED=1
fi

must_hold_line="$(printf '%s\n' "${SECTION}" | grep -iE '^[[:space:]]*[-*][[:space:]]*\[[xX]\].*must-hold' | head -1 || true)"

if [ "${BEHAVIOR_CHANGED}" -eq 1 ]; then
  if [ -z "${proof_line}" ]; then
    echo "FAIL: behavior change needs a red proof line (the test that failed before the change)." >&2
    exit 1
  fi
  proof_value="$(printf '%s\n' "${proof_line}" | sed -E 's/^[^:]*:[[:space:]]*//')"
  proof_compact="$(printf '%s' "${proof_value}" | tr -d '[:space:]`')"
  proof_lower="$(printf '%s' "${proof_compact}" | tr '[:upper:]' '[:lower:]')"
  if [ -z "${proof_compact}" ] || [ "${proof_lower}" = "n/a" ]; then
    echo "FAIL: behavior change needs a red proof (a test path), not N/A." >&2
    exit 1
  fi
  # Untouched template compact-strips to path/to/test.ts|N/A and must not pass.
  if [[ "${proof_lower}" == *"path/to/test.ts"* ]]; then
    echo "FAIL: behavior change needs a red proof (a test path), not the template placeholder." >&2
    exit 1
  fi
  if printf '%s\n' "${must_hold_line}" | grep -qiE 'N/A'; then
    echo "FAIL: behavior change cannot mark Red must-hold as N/A." >&2
    exit 1
  fi
fi

echo "PASS: agent ship loop checklist is complete."
exit 0
