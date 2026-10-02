#!/usr/bin/env bash
# Unit tests for agent-guard.sh.
# Run: bash scripts/hooks/agent-guard.test.sh
#
# Every case goes through the PreToolUse matcher in .claude/settings.json before
# it reaches the guard, because that is the order production uses. An earlier
# version of this suite piped payloads straight into the script, so it proved
# the case arms worked and not that they were reachable: the matcher named three
# tools and merge_pull_request was not one of them, and eleven green assertions
# sat on top of a branch that never ran.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
GUARD="${SCRIPT_DIR}/agent-guard.sh"
SETTINGS="${SCRIPT_DIR}/../../.claude/settings.json"

MATCHER="$(jq -r '.hooks.PreToolUse[] | select(.hooks[].command | test("agent-guard")) | .matcher' "${SETTINGS}")"
[ -n "${MATCHER}" ] || { echo "FAIL: no PreToolUse matcher routes agent-guard.sh"; exit 1; }
echo "routing through the matcher in .claude/settings.json: ${MATCHER}"

# The decision production reaches: "unrouted" when the matcher never calls the
# hook, "pass" when the hook waves the call through, otherwise the denial.
decision() {
  local payload="$1" name
  name="$(printf '%s' "${payload}" | jq -r '.tool_name // ""')"
  if ! printf '%s' "${name}" | grep -qE "${MATCHER}"; then
    printf 'unrouted'
    return 0
  fi
  printf '%s' "${payload}" | bash "${GUARD}" |
    jq -r '.hookSpecificOutput.permissionDecision // "pass"'
}

bash_call() {
  jq -nc --arg cmd "$1" '{tool_name:"Bash",tool_input:{command:$cmd}}'
}

# About 1.3 MB of ordinary lines to follow the first line: more than a pipe
# holds, and more than one argument may carry (128 KiB on Linux, 1 MiB on macOS).
LARGE_PADDING="$(seq -f 'echo padding line %05g with ordinary words' 1 30000)"

large_bash_call() {
  printf '%s\n%s' "$1" "${LARGE_PADDING}" | jq -Rsc '{tool_name:"Bash",tool_input:{command:.}}'
}

echo "=== agent-guard tests ==="

# --- local sessions are untouched -------------------------------------------
# A person is present to answer the user-level "ask" hooks, and /open-pr is a
# normal part of local work. Enforcing here would break it.
unset CLAUDE_CODE_REMOTE
assert_eq "a local session may open a non-draft pull request" "pass" \
  "$(decision "$(bash_call 'gh pr create --base main')")"
assert_eq "a local session is not denied a recursive delete" "pass" \
  "$(decision "$(bash_call 'rm -rf /some/dir')")"
assert_eq "a local session may edit the guard" "pass" \
  "$(decision '{"tool_name":"Edit","tool_input":{"file_path":"scripts/hooks/agent-guard.sh"}}')"

# --- cloud sessions are unattended ------------------------------------------
export CLAUDE_CODE_REMOTE=true

# Pull requests: draft, explicit base. main is the only base.
assert_eq "a cloud run may not open a pull request that is not a draft" "deny" \
  "$(decision "$(bash_call 'gh pr create --base main')")"
assert_eq "a cloud run may not open a non-draft one through an MCP tool either" "deny" \
  "$(decision '{"tool_name":"mcp__github__create_pull_request","tool_input":{"title":"x","base":"main"}}')"
assert_eq "a draft with no base is denied, because gh would target the repository default" "deny" \
  "$(decision "$(bash_call 'gh pr create --draft --title x --body y')")"
assert_eq "an MCP draft with no base is denied for the same reason" "deny" \
  "$(decision '{"tool_name":"mcp__github__create_pull_request","tool_input":{"title":"x","draft":true}}')"
assert_eq "a quoted base still counts as an explicit base" "pass" \
  "$(decision "$(bash_call 'gh pr create --draft --base "main" --title x')")"
assert_eq "the short base flag counts as an explicit base" "pass" \
  "$(decision "$(bash_call 'gh pr create --draft -B main --title x')")"

# Ready and merge.
assert_eq "a cloud run may not mark a draft ready" "deny" \
  "$(decision "$(bash_call 'gh pr ready 1528')")"
assert_eq "a cloud run may not mark one ready through an MCP tool" "deny" \
  "$(decision '{"tool_name":"mcp__github__update_pull_request","tool_input":{"pullNumber":1,"draft":false}}')"
assert_eq "a cloud run may not merge a pull request" "deny" \
  "$(decision "$(bash_call 'gh pr merge 1528 --squash')")"
assert_eq "a cloud run may not merge one through an MCP tool" "deny" \
  "$(decision '{"tool_name":"mcp__github__merge_pull_request","tool_input":{"pullNumber":1}}')"

# The REST API reaches the same endpoints without naming a subcommand.
assert_eq "a cloud run may not merge through the REST API" "deny" \
  "$(decision "$(bash_call 'gh api -X PUT repos/example-org/example-repo/pulls/1608/merge')")"
assert_eq "a cloud run may not reach the REST API with curl either" "deny" \
  "$(decision "$(bash_call 'curl -X PUT https://api.github.com/repos/example-org/example-repo/pulls/1608/merge')")"

# Issues.
assert_eq "a cloud run may not change issue state through an MCP tool" "deny" \
  "$(decision '{"tool_name":"mcp__github__issue_write","tool_input":{"state":"closed"}}')"
assert_eq "a cloud run may not close an issue" "deny" \
  "$(decision "$(bash_call 'gh issue close 1528')")"

# Commits, pushes, the stash stack, databases.
assert_eq "a cloud run may not skip the pre-commit gate" "deny" \
  "$(decision "$(bash_call 'git commit --no-verify -m x')")"
assert_eq "the short no-verify flag is denied when it comes last" "deny" \
  "$(decision "$(bash_call 'git commit -m x -n')")"
assert_eq "a cloud run may not push to main" "deny" \
  "$(decision "$(bash_call 'git push origin main')")"
assert_eq "a refspec does not get a push to main past the rule" "deny" \
  "$(decision "$(bash_call 'git push origin HEAD:main')")"
assert_eq "a cloud run may not use the shared stash stack" "deny" \
  "$(decision "$(bash_call 'git stash')")"
assert_eq "git stash push writes to that same stack and is denied" "deny" \
  "$(decision "$(bash_call 'git stash push -m wip')")"
assert_eq "a cloud run may not reset a database" "deny" \
  "$(decision "$(bash_call 'docker compose -f infra/hatchet/compose.yaml down -v')")"

# scan-destructive.sh answers "ask", which nobody is present to answer.
assert_eq "a destructive delete is escalated from ask to deny" "deny" \
  "$(decision "$(bash_call 'rm -rf /Users/someone/Projects/other')")"
assert_eq "one rebuildable target does not clear the rest of the command" "deny" \
  "$(decision "$(bash_call 'rm -rf node_modules /Users/someone/Projects/other')")"
assert_eq "a database mutation is escalated from ask to deny" "deny" \
  "$(decision "$(bash_call 'psql "$DATABASE_URL" -c "DELETE FROM contacts"')")"

# The run may not rewrite the rules it runs under.
assert_eq "a cloud run may not edit the guard" "deny" \
  "$(decision '{"tool_name":"Edit","tool_input":{"file_path":"/repo/scripts/hooks/agent-guard.sh"}}')"
assert_eq "a cloud run may not rewrite the settings that route the guard" "deny" \
  "$(decision '{"tool_name":"Write","tool_input":{"file_path":"/repo/.claude/settings.json"}}')"
assert_eq "a cloud run may not delete the destructive-command screen from the shell" "deny" \
  "$(decision "$(bash_call 'rm -f scripts/hooks/scan-destructive.sh')")"
assert_eq "a cloud run may not patch the guard from the shell" "deny" \
  "$(decision "$(bash_call 'sed -i.bak s/deny/echo/ scripts/hooks/agent-guard.sh')")"

# --- commands larger than a pipe or an argument -----------------------------
# A reader that stops at the first match breaks the pipe of a writer that still
# has text to send, and a reason that carries the command can outgrow argv.
# Either one used to turn a denial into a pass.
assert_eq "a non-draft pull request inside a 1.3 MB command is still denied" "deny" \
  "$(decision "$(large_bash_call 'gh pr create --base main --title x')")"
assert_eq "patching the guard inside a 1.3 MB command is still denied" "deny" \
  "$(decision "$(large_bash_call 'sed -i.bak s/deny/echo/ scripts/hooks/agent-guard.sh')")"
assert_eq "a destructive delete inside a 1.3 MB command is still escalated to deny" "deny" \
  "$(decision "$(large_bash_call 'rm -rf /Users/someone/Projects/other')")"
assert_eq "a draft against main inside a 1.3 MB command still passes" "pass" \
  "$(decision "$(large_bash_call 'gh pr create --draft --base main --title x')")"

# --- the work the run is actually there to do -------------------------------
assert_eq "a cloud run may push to its own claude/ branch" "pass" \
  "$(decision "$(bash_call 'git push -u origin claude/issue-1528')")"
assert_eq "a cloud run may comment on an issue" "pass" \
  "$(decision "$(bash_call 'gh issue comment 1528 --body hi')")"
assert_eq "a cloud run may open a draft against main" "pass" \
  "$(decision "$(bash_call 'gh pr create --draft --base main --title x --body y')")"
assert_eq "a cloud run may open an MCP draft against main" "pass" \
  "$(decision '{"tool_name":"mcp__github__create_pull_request","tool_input":{"title":"x","draft":true,"base":"main"}}')"
assert_eq "a cloud run may read a pull request" "pass" \
  "$(decision '{"tool_name":"mcp__github__pull_request_read","tool_input":{"pullNumber":1}}')"
assert_eq "a cloud run may run the check loop" "pass" \
  "$(decision "$(bash_call 'pnpm check:changed')")"
assert_eq "a cloud run may delete rebuildable output" "pass" \
  "$(decision "$(bash_call 'rm -rf node_modules')")"
assert_eq "a cloud run may delete several rebuildable paths at once" "pass" \
  "$(decision "$(bash_call 'rm -rf node_modules apps/web/dist')")"
assert_eq "a cloud run may read the stash stack" "pass" \
  "$(decision "$(bash_call 'git stash list')")"
assert_eq "a cloud run may edit ordinary source" "pass" \
  "$(decision '{"tool_name":"Edit","tool_input":{"file_path":"apps/api/src/index.ts"}}')"
assert_eq "a cloud run may read the GitHub REST API" "pass" \
  "$(decision "$(bash_call 'gh api repos/example-org/example-repo/pulls/1608')")"

# --- the screen must not fail open ------------------------------------------
# Every one of these is a way the guard could stop being able to tell a
# destructive command from a safe one. Each must end in a denial, not a pass.
ISOLATED="$(mktemp -d)"
FAKEBIN="$(mktemp -d)"
trap 'rm -rf "${ISOLATED}" "${FAKEBIN}"' EXIT
cp "${GUARD}" "${ISOLATED}/agent-guard.sh"

raw_decision() {
  printf '%s' "$(bash_call 'echo hello')" | "$@" |
    jq -r '.hookSpecificOutput.permissionDecision // "pass"'
}

assert_eq "a missing destructive-command screen denies rather than allows" "deny" \
  "$(raw_decision bash "${ISOLATED}/agent-guard.sh")"

# A screen that runs but fails is the same blindness as one that is absent.
printf '#!/usr/bin/env bash\nexit 1\n' >"${ISOLATED}/scan-destructive.sh"
assert_eq "a screen that exits non-zero denies rather than allows" "deny" \
  "$(raw_decision bash "${ISOLATED}/agent-guard.sh")"
printf '#!/usr/bin/env bash\necho not json\n' >"${ISOLATED}/scan-destructive.sh"
assert_eq "a screen that returns something other than JSON denies rather than allows" "deny" \
  "$(raw_decision bash "${ISOLATED}/agent-guard.sh")"

# Without jq the guard cannot read the payload; without perl it cannot
# normalise quotes, so --base "main" would read differently from --base main.
for tool in bash cat dirname grep sed env perl jq; do
  path="$(command -v "${tool}")" && ln -sf "${path}" "${FAKEBIN}/${tool}"
done
assert_eq "a guard with no jq denies rather than allows" "deny" \
  "$(rm -f "${FAKEBIN}/jq"
    printf '%s' "$(bash_call 'git push origin main')" |
      env -i PATH="${FAKEBIN}" CLAUDE_CODE_REMOTE=true bash "${GUARD}" |
      jq -r '.hookSpecificOutput.permissionDecision // "pass"')"
ln -sf "$(command -v jq)" "${FAKEBIN}/jq"
assert_eq "a guard with no perl denies rather than allows" "deny" \
  "$(rm -f "${FAKEBIN}/perl"
    printf '%s' "$(bash_call 'git push origin main')" |
      env -i PATH="${FAKEBIN}" CLAUDE_CODE_REMOTE=true bash "${GUARD}" |
      jq -r '.hookSpecificOutput.permissionDecision // "pass"')"

gate_test_finish
