#!/usr/bin/env bash
# PreToolUse — hard denials for a cloud session that nobody is watching.
#
# A cloud session has no permission mode, so "ask" is never shown to anyone and
# is equivalent to "allow". This hook emits "deny", which holds regardless.
# Local sessions pass straight through: the user-level hooks still run there and
# a human is present to answer them.
#
# Two rules decide everything below.
#
#   Fail closed. A missing jq, a missing perl, or a screen that returns
#   something other than well-formed JSON is a denial, not a pass. An earlier
#   version denied only when scan-destructive.sh was absent, so an unreadable
#   or crashing screen waved every command through.
#
#   Match the normalised command, and match it twice. Quoting is not a way past
#   a rule: --base "main" and --base main are the same instruction, so both
#   forms are tested. A word that only appears inside quotes is still tested,
#   which denies `echo "gh pr merge"`. That is the direction to be wrong in.
#
# Denied in the cloud:
#   1. opening a pull request that is not a draft, or that carries no explicit
#      base. A draft against main is the deliverable.
#   2. marking a pull request ready, or merging it
#   3. closing or reopening a GitHub issue   (a run is comment-only)
#   4. any writing GitHub REST call            (gh api -X POST, curl, MCP)
#   5. git commit --no-verify / -n           (the pre-commit hook is the gate)
#   6. any push naming main
#   7. dropping or resetting a database
#   8. git stash other than list / show      (the stack is shared across worktrees)
#   9. editing this guard, its screen, or the settings file that routes them
#
# Then everything scan-destructive.sh flags is escalated from "ask" to "deny".
# That script stays the source of truth for destructive and SQL-mutation
# patterns; this file does not copy its list.
set -uo pipefail

# Local sessions keep their existing behaviour, including the ability to open a
# pull request. Only a cloud session (CLAUDE_CODE_REMOTE=true) is unattended.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || { echo '{}'; exit 0; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Denials before jq is known to exist cannot be built with jq. This one reason
# is fixed text with nothing interpolated, so it is safe to write by hand.
if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Denied: jq is not on PATH, so this call cannot be screened at all. Every rule in scripts/hooks/agent-guard.sh reads the tool payload with jq. Install jq before running unattended."}}'
  exit 0
fi

deny() {
  # On stdin: an escalated reason quotes the command, which can outgrow argv.
  printf '%s' "$1" |
    jq -Rsc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:.}}'
  exit 0
}

command -v perl >/dev/null 2>&1 ||
  deny "Denied: perl is not on PATH, so quoted arguments cannot be normalised and a rule could be stepped around by adding quotes. Install perl before running unattended."

payload="$(cat)"
tool="$(printf '%s' "$payload" | jq -r '.tool_name // ""')"
[ -n "$tool" ] ||
  deny "Denied: the hook payload carried no tool_name, so this call cannot be identified. Nothing runs unscreened in an unattended session."

# Paths whose contents decide what this session may do. A run that can rewrite
# them can lift every other rule here, so they are read-only to the run itself.
SELF_PATHS='scripts/hooks/agent-guard\.sh|scripts/hooks/scan-destructive\.sh|\.claude/settings\.json'

guarded_path() {
  grep -qE "$SELF_PATHS" <<<"$1"
}

# Recursive deletes a run legitimately needs: rebuildable output and scratch.
#
# Every target has to be rebuildable, not one of them. The earlier version asked
# whether the command mentioned node_modules anywhere, so
# `rm -rf node_modules apps/api/src` passed on the strength of the first word.
rm_targets_all_rebuildable() {
  local targets
  targets="$(printf '%s' "$1" | perl -0777 -ne '
    while (/(?:^|[|;&(]|\s)rm\s+([^|;&\n]+)/g) {
      for my $t (split /\s+/, $1) {
        next if $t eq "" or $t =~ /^-/;
        print "$t\n";
      }
    }
  ')" || return 1
  [ -n "$targets" ] || return 1
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    grep -qE '(^|/)(node_modules|dist|build|coverage|\.turbo|\.next|\.vite)(/|$)|^/tmp/|(^|/)tmp/' <<<"$target" ||
      return 1
  done <<<"$targets"
  return 0
}

case "$tool" in
  Edit|Write|MultiEdit|NotebookEdit)
    path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')"
    if guarded_path "$path"; then
      deny "Denied: that file is the guard for this session, or the settings that route it. A run may not edit the rules it runs under. Report the change you want on the issue."
    fi
    echo '{}'
    exit 0
    ;;
  *create_pull_request*)
    draft="$(printf '%s' "$payload" | jq -r '.tool_input.draft // false')"
    base="$(printf '%s' "$payload" | jq -r '.tool_input.base // ""')"
    if [ "$draft" != "true" ]; then
      deny "Denied: a cloud run opens draft pull requests only. Pass draft: true. Matt marks it ready."
    fi
    if [ -z "$base" ]; then
      deny "Denied: name the base branch explicitly (base: main). An implicit base is a guess."
    fi
    ;;
  *merge_pull_request*)
    deny "Denied: a cloud run never merges a pull request. Matt merges."
    ;;
  *update_pull_request*|*pull_request_write*)
    # Clearing the draft flag is how an update marks a pull request ready.
    if printf '%s' "$payload" | jq -e '.tool_input.draft == false' >/dev/null 2>&1; then
      deny "Denied: a cloud run never marks a pull request ready. Matt does."
    fi
    ;;
  *issue_write*)
    state="$(printf '%s' "$payload" | jq -r '.tool_input.state // ""')"
    if [ -n "$state" ]; then
      deny "Denied: a cloud run is comment-only. Use add_issue_comment; never change an issue's state."
    fi
    ;;
  *push_files*|*create_or_update_file*|*delete_file*|*create_branch*)
    branch="$(printf '%s' "$payload" | jq -r '.tool_input.branch // ""')"
    case "$branch" in
      main)
        deny "Denied: main is the integration branch. Write to a claude/ branch and open a draft pull request."
        ;;
    esac
    ;;
  Bash)
    cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')"

    # Two normalised readings of the same command.
    #
    # CODE drops heredoc bodies and quoted literals, so a word that is only
    # ever data does not read as a command. That is what scan-destructive.sh
    # does, and the two must agree or a command screened by one slips the other.
    #
    # BARE drops heredoc bodies and the quote characters but keeps what was
    # inside them, so --base "main" reads as --base main.
    CODE="$(printf '%s' "$cmd" | perl -0777 -pe '
      s/<<-?\s*(["\x27]?)(\w+)\1.*?^\s*\2\s*$/ /msg;
      s/\x27[^\x27]*\x27/ /g;
      s/"(?:\\.|[^"\\])*"/ /g;
    ')" || deny "Denied: the command could not be normalised for screening. Nothing runs unscreened in an unattended session."
    BARE="$(printf '%s' "$cmd" | perl -0777 -pe '
      s/<<-?\s*(["\x27]?)(\w+)\1.*?^\s*\2\s*$/ /msg;
      s/["\x27]/ /g;
    ')" || deny "Denied: the command could not be normalised for screening. Nothing runs unscreened in an unattended session."

    # True when either reading matches. Quoting is not an escape hatch.
    # Here-strings, not pipes: grep -q stops reading at its first match (see the 1.3 MB self-test cases).
    matches() {
      grep -qE -- "$1" <<<"$CODE" && return 0
      grep -qE -- "$1" <<<"$BARE"
    }

    if matches '\bgh\b[^|;&]*\bpr\b[^|;&]*\bcreate\b'; then
      if ! matches '([[:space:]]--draft([[:space:]]|=|$)|[[:space:]]-[a-zA-Z]*d[a-zA-Z]*([[:space:]]|$))'; then
        deny "Denied: a cloud run opens draft pull requests only. Add --draft. Matt marks it ready."
      fi
      # Left out, --base falls back to the repository default, which is main.
      if ! matches '(--base|[[:space:]]-B)([[:space:]]|=)'; then
        deny "Denied: name the base branch explicitly with --base main. An implicit base is a guess."
      fi
    fi

    # Marking a draft ready, or merging, is Matt's call in every mode.
    if matches '\bgh\b[^|;&]*\bpr\b[^|;&]*\b(ready|merge)\b'; then
      deny "Denied: a cloud run never marks a pull request ready or merges it. Leave it as a draft and report on the issue."
    fi
    if matches '\bgh\b[^|;&]*\bpr\b[^|;&]*\bedit\b[^|;&]*--(ready|base)\b'; then
      deny "Denied: a cloud run never marks a pull request ready or changes its base. Matt does."
    fi

    if matches '\bgh\b[^|;&]*\bissue\b[^|;&]*\b(close|reopen|delete)\b'; then
      deny "Denied: a cloud run is comment-only. Post evidence with 'gh issue comment'; Matt closes issues after reading the report."
    fi
    if matches '\bgh\b[^|;&]*\bissue\b[^|;&]*\bedit\b[^|;&]*--(add-|remove-)?state\b'; then
      deny "Denied: a cloud run is comment-only. Do not change issue state."
    fi

    # Every rule above reads a subcommand word. The REST API has none of them:
    # `gh api -X PUT repos/o/r/pulls/1/merge` merges without saying pr or merge.
    # A run needs no writing REST call at all, so the method is the whole test.
    if matches '\bgh[[:space:]]+api\b' &&
      matches '(-X|--method)[[:space:]=]+(POST|PUT|PATCH|DELETE|post|put|patch|delete)\b'; then
      deny "Denied: a writing call to the GitHub REST API steps around every rule that reads a gh subcommand. Use the gh subcommand or the MCP tool for what you need; both are screened."
    fi
    if matches 'api\.github\.com' &&
      matches '(-X|--request)[[:space:]=]+(POST|PUT|PATCH|DELETE|post|put|patch|delete)\b'; then
      deny "Denied: a writing call to the GitHub REST API steps around every rule that reads a gh subcommand. Use the gh subcommand or the MCP tool for what you need; both are screened."
    fi

    # -n is --no-verify. It can sit anywhere, including last, and can be bundled
    # with other short flags: git commit -am x -n.
    if matches '\bgit\b[^|;&]*\bcommit\b[^|;&]*(--no-verify|[[:space:]]-[a-zA-Z]*n[a-zA-Z]*([[:space:]]|$))'; then
      deny "Denied: --no-verify skips the pre-commit gate. If check-changed fails, fix the code."
    fi

    # A branch can be named in a refspec (HEAD:main), after origin, or on its
    # own, so the word anywhere in a push is the test. A claude/ branch never
    # contains it, and denying a branch that happens to is the safe way to be
    # wrong.
    if matches '\bgit\b[^|;&]*\bpush\b' && matches '\bmain\b'; then
      deny "Denied: push only to a claude/ branch. main is the integration branch. A refspec such as HEAD:main is the same push."
    fi

    if matches 'dropdb|docker[[:space:]]+compose[^|;&]*down[^|;&]*(-v|--volumes)'; then
      deny "Denied: that destroys the local engine database. Stop the stack without -v, or report on the issue."
    fi

    # push writes to the shared stack, which is what makes stash unsafe across
    # worktrees. Only the two readers are allowed.
    if matches '\bgit[[:space:]]+stash\b' &&
      ! matches '\bgit[[:space:]]+stash[[:space:]]+(list|show)\b'; then
      deny "Denied: the stash stack is shared across worktrees. Use a temporary WIP commit instead."
    fi

    # A run that can rewrite the guard can lift every rule in it. Edit and Write
    # are covered above; this covers the shell paths to the same files.
    if guarded_path "$BARE" &&
      matches '(\brm\b|\bsed\b[^|;&]*-i|\btee\b|\btruncate\b|\bmv\b|\bchmod\b|>[[:space:]]*[^|;&>]*(agent-guard|scan-destructive|settings\.json))'; then
      deny "Denied: that rewrites or removes the guard for this session, or the settings that route it. A run may not edit the rules it runs under. Report the change you want on the issue."
    fi

    scanner="${HERE}/scan-destructive.sh"
    [ -r "$scanner" ] ||
      deny "Denied: scripts/hooks/scan-destructive.sh is missing, so destructive commands cannot be screened. Restore it before running in the cloud."

    scanned="$(printf '%s' "$payload" | bash "$scanner" 2>/dev/null)"
    scanner_status=$?
    if [ "$scanner_status" -ne 0 ] || [ -z "$scanned" ] ||
      ! printf '%s' "$scanned" | jq -e . >/dev/null 2>&1; then
      deny "Denied: scripts/hooks/scan-destructive.sh did not return a usable decision, so destructive commands cannot be screened. Fix the screen before running in the cloud."
    fi

    flagged="$(printf '%s' "$scanned" | jq -r '.hookSpecificOutput.permissionDecision // ""')"
    if [ "$flagged" = "ask" ] && ! rm_targets_all_rebuildable "$BARE"; then
      reason="$(printf '%s' "$scanned" | jq -r '.hookSpecificOutput.permissionDecisionReason // ""')"
      deny "Escalated to deny for an unattended run. scan-destructive.sh would only have asked, and nobody is present to answer. Original: ${reason}"
    fi
    ;;
esac

echo '{}'
