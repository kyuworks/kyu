#!/usr/bin/env bash
# Fixture tests for check-agent-ship-loop.sh (#1974).
# Run: bash scripts/gates/check-agent-ship-loop.test.sh
#
# Must hold: an agent PR body with the ship-loop heading and unchecked
# boxes never passes. A human typo body with no heading still passes.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-agent-ship-loop.sh"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

run_body() {
  bash "${CHECK}" --body "$1" "${@:2}"
}

assert_file_contains() {
  local desc="$1" file="$2" needle="$3"
  if [ ! -f "${file}" ]; then
    gate_test_record "${desc}" 1
    echo "  missing file: ${file}"
    return
  fi
  if grep -Fq -- "${needle}" "${file}"; then
    gate_test_record "${desc}" 0
  else
    gate_test_record "${desc}" 1
    echo "  missing [${needle}] in ${file}"
  fi
}

HUMAN="${TMP}/human.md"
cat > "${HUMAN}" <<'EOF'
## Summary
Fix a typo in the README.

## How to check
- Read the sentence.

Closes #1
EOF

INCOMPLETE="${TMP}/incomplete.md"
cat > "${INCOMPLETE}" <<'EOF'
## Summary
Add a filter to the contact list.

## Agent ship loop

Behavior changed: yes
Red proof:

- [ ] Plan (call stacks if this adds or edits a request path)
- [ ] Red must-hold
- [ ] Smallest diff
- [ ] `pnpm check:changed` (commit hook counts)
- [ ] Separate review (not the author)
- [ ] Hosted CI — do not claim done from a local green

Closes #2
EOF

PARTIAL="${TMP}/partial.md"
cat > "${PARTIAL}" <<'EOF'
## Summary
Add a filter to the contact list.

## Agent ship loop

Behavior changed: yes
Red proof:

- [x] Plan (N/A — no request path)
- [ ] Red must-hold
- [x] Smallest diff
- [x] `pnpm check:changed` (commit hook counts)
- [x] Separate review (not the author)
- [x] Hosted CI — do not claim done from a local green
EOF

NO_RED="${TMP}/no-red.md"
cat > "${NO_RED}" <<'EOF'
## Summary
Add a filter to the contact list.

## Agent ship loop

Behavior changed: yes
Red proof: N/A

- [x] Plan (N/A — no request path)
- [x] Red must-hold (N/A: docs only)
- [x] Smallest diff
- [x] `pnpm check:changed` (commit hook counts)
- [x] Separate review (not the author)
- [x] Hosted CI — do not claim done from a local green
EOF

COMPLETE="${TMP}/complete.md"
cat > "${COMPLETE}" <<'EOF'
## Summary
Add a filter to the contact list.

## Agent ship loop

Behavior changed: yes
Red proof: `apps/api/src/contacts/listContacts.test.ts`

- [x] Plan (N/A — no request path)
- [x] Red must-hold
- [x] Smallest diff
- [x] `pnpm check:changed` (commit hook counts)
- [x] Separate review (not the author)
- [x] Hosted CI — do not claim done from a local green
EOF

DOCS_ONLY="${TMP}/docs-only.md"
cat > "${DOCS_ONLY}" <<'EOF'
## Summary
Clarify the onboarding note.

## Agent ship loop

Behavior changed: no
Red proof: N/A

- [x] Plan (N/A — docs only)
- [x] Red must-hold (N/A: docs / lint / rename / generated-only)
- [x] Smallest diff
- [x] `pnpm check:changed` (commit hook counts)
- [x] Separate review (not the author)
- [x] Hosted CI — do not claim done from a local green
EOF

EMPTY_TEMPLATE="${TMP}/empty-template.md"
cat > "${EMPTY_TEMPLATE}" <<'EOF'
## Summary
Fix a typo.

## Agent ship loop

<!-- Agents fill this. Humans delete this whole heading on tiny PRs. -->

Behavior changed: yes | no
Red proof: `path/to/test.ts` | N/A

- [ ] Plan (call stacks if this adds or edits a request path, job, or webhook; otherwise N/A)
- [ ] Red must-hold (or N/A: docs / lint / rename / generated-only)
- [ ] Smallest diff
- [ ] `pnpm check:changed` (commit hook counts)
- [ ] Separate review (not the author)
- [ ] Hosted CI — do not claim done from a local green
EOF

PLACEHOLDER_PROOF="${TMP}/placeholder-proof.md"
cat > "${PLACEHOLDER_PROOF}" <<'EOF'
## Summary
Add a filter to the contact list.

## Agent ship loop

Behavior changed: yes
Red proof: `path/to/test.ts` | N/A

- [x] Plan (N/A — no request path)
- [x] Red must-hold
- [x] Smallest diff
- [x] `pnpm check:changed` (commit hook counts)
- [x] Separate review (not the author)
- [x] Hosted CI — do not claim done from a local green
EOF

NO_HEADING_AGENT="${TMP}/no-heading.md"
cat > "${NO_HEADING_AGENT}" <<'EOF'
## Summary
Add a filter to the contact list.

## How to check
- Look at the list.

Closes #3
EOF

echo "=== check-agent-ship-loop ==="

assert_exit "human typo body with no heading passes" 0 \
  run_body "${HUMAN}"
assert_output_contains "human shortcut is named" "human shortcut" \
  run_body "${HUMAN}"

assert_exit "empty template left on a human PR passes" 0 \
  run_body "${EMPTY_TEMPLATE}"

assert_exit "incomplete agent body fails" 1 \
  run_body "${INCOMPLETE}" --agent
assert_output_contains "incomplete agent names an unchecked item" "not checked" \
  run_body "${INCOMPLETE}" --agent

assert_exit "partially checked agent body fails" 1 \
  run_body "${PARTIAL}" --agent

assert_exit "behavior change with N/A red proof fails" 1 \
  run_body "${NO_RED}" --agent --behavior-changed
assert_output_contains "missing red proof is named" "red proof" \
  run_body "${NO_RED}" --agent --behavior-changed

LARGE_TAIL="${TMP}/large-tail.md"
{
  cat "${COMPLETE}"
  printf '\n## Notes\n'
  awk 'BEGIN { for (i = 1; i <= 20000; i++) printf "padding line %05d keeps this body larger than a pipe buffer\n", i }'
} > "${LARGE_TAIL}"

EMPTY_SECTION_LARGE_TAIL="${TMP}/empty-section-large-tail.md"
{
  printf '## Agent ship loop\n\n## Notes\n'
  awk 'BEGIN { for (i = 1; i <= 20000; i++) printf "padding line %05d keeps this body larger than a pipe buffer\n", i }'
} > "${EMPTY_SECTION_LARGE_TAIL}"

assert_exit "a complete body followed by a large section passes" 0 \
  run_body "${LARGE_TAIL}" --agent
assert_exit "an empty section followed by a large section fails" 1 \
  run_body "${EMPTY_SECTION_LARGE_TAIL}" --agent
assert_last_output_contains "the empty section names the first unchecked item" "not checked: Plan"

assert_exit "complete agent body passes" 0 \
  run_body "${COMPLETE}" --agent
assert_exit "complete agent body passes with behavior-changed" 0 \
  run_body "${COMPLETE}" --agent --behavior-changed

assert_exit "agent body with template red-proof placeholder fails" 1 \
  run_body "${PLACEHOLDER_PROOF}" --agent --behavior-changed
assert_output_contains "placeholder red proof is named" "red proof" \
  run_body "${PLACEHOLDER_PROOF}" --agent --behavior-changed

assert_exit "docs-only agent body passes" 0 \
  run_body "${DOCS_ONLY}" --agent
assert_exit "behavior-changed flag rejects a docs-only N/A proof" 1 \
  run_body "${DOCS_ONLY}" --agent --behavior-changed

assert_exit "cursor/ branch without the section fails" 1 \
  run_body "${NO_HEADING_AGENT}" --branch cursor/agent-ship-loop-85a1
assert_output_contains "missing section is named" "Agent ship loop" \
  run_body "${NO_HEADING_AGENT}" --branch cursor/agent-ship-loop-85a1

assert_exit "cursor[bot] author without the section fails" 1 \
  run_body "${NO_HEADING_AGENT}" --author 'cursor[bot]'

assert_exit "dependabot without the section passes" 0 \
  run_body "${NO_HEADING_AGENT}" --author 'dependabot[bot]'

assert_file_contains "AGENTS.md names the agent ship loop" \
  "${ROOT_DIR}/AGENTS.md" "## Agent ship loop"
assert_file_contains "AGENTS.md names red must-hold" \
  "${ROOT_DIR}/AGENTS.md" "Red must-hold"
assert_file_contains "AGENTS.md lets humans shortcut" \
  "${ROOT_DIR}/AGENTS.md" "Humans may shortcut"
assert_file_contains "PR template has the agent section" \
  "${ROOT_DIR}/.github/PULL_REQUEST_TEMPLATE.md" "## Agent ship loop"
assert_file_contains "plan skill has Call stacks" \
  "${ROOT_DIR}/.agents/skills/plan/SKILL.md" "## Call stacks"
assert_file_contains "pr-review rejects a missing red proof on agent PRs" \
  "${ROOT_DIR}/.agents/skills/pr-review/SKILL.md" "Agent ship loop"
assert_file_contains "verify-gates.sh runs the gate" \
  "${ROOT_DIR}/scripts/verify-gates.sh" "check-agent-ship-loop"
assert_file_contains "the Ship loop workflow runs the gate on a body edit" \
  "${ROOT_DIR}/.github/workflows/ship-loop.yml" "types: [opened, edited, synchronize, reopened]"
assert_file_contains "the Ship loop workflow runs the gate script" \
  "${ROOT_DIR}/.github/workflows/ship-loop.yml" "scripts/gates/check-agent-ship-loop.sh"

gate_test_finish
