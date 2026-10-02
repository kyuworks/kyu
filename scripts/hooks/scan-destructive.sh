#!/bin/bash
# PreToolUse — flag genuinely destructive commands for confirmation.
#
# Reasons are built with jq, not string-interpolated into a heredoc. The
# patterns contain backslash escapes (\s, \b) which are not valid JSON escapes,
# so an interpolated heredoc emitted malformed JSON and the hook was silently
# ignored. Keep every reason going through jq, on stdin: a reason quotes the
# command, and a large command is too long to be one argument.
#
# Two rules keep this from firing on every other command:
#   1. Shell checks run against the command with quoted literals and heredoc
#      bodies removed, so a grep pattern or an echoed string is never a match.
#   2. Database checks run only when the command actually invokes a database
#      client. Reading a migration or a doc that contains DDL words is not a
#      mutation and must not prompt.
set -uo pipefail

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && { echo '{}'; exit 0; }

ask() {
  printf '%s' "$1" |
    jq -Rsc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:.}}'
  exit 0
}

# Everything the shell would treat as data rather than as a command word.
CODE=$(printf '%s' "$CMD" | perl -0777 -pe '
  s/<<-?\s*(["\x27]?)(\w+)\1.*?^\s*\2\s*$//msg;
  s/\x27[^\x27]*\x27/ /g;
  s/"(?:\\.|[^"\\])*"/ /g;
')

# Tier 1: irreversible shell and git operations.
SHELL_PATTERNS=(
  '(^|[|;&(]|\s)rm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*(\s|$)'
  '(^|[|;&(]|\s)git\s[^|;&]*\breset\b[^|;&]*--hard\b'
  '(^|[|;&(]|\s)git\s+checkout\s+\.(\s|$)'
  '(^|[|;&(]|\s)git\s[^|;&]*\bclean\b[^|;&]*\s-[a-zA-Z]*f'
  '(^|[|;&(]|\s)git\s[^|;&]*\bpush\b[^|;&]*\s(-f|--force|--force-with-lease)(\s|=|$)'
  '(^|[|;&(]|\s)git\s[^|;&]*\bbranch\b[^|;&]*\s-D(\s|$)'
  '(^|[|;&(]|\s)git\s[^|;&]*\bworktree\b[^|;&]*\bremove\b[^|;&]*--force\b'
  '(^|[|;&(]|\s)wrangler\s[^|;&]*\bdelete\b'
)

# Here-strings, not pipes: under pipefail, grep -q stopping early breaks the writer's pipe and a match reads as a miss.
for pat in "${SHELL_PATTERNS[@]}"; do
  if grep -qE "$pat" <<<"$CODE"; then
    ask "🔴 DESTRUCTIVE command detected: matches ${pat}. Command: ${CMD}"
  fi
done

# Tier 2: data-changing statements, but only when a database client runs them.
DB_CLIENT='(^|[|;&(]|\s)(psql|mysql|mariadb|sqlite3|pg_dump|pg_restore|pgcli|cockroach|usql|drizzle-kit|prisma|atlas|flyway|sqlx)(\s|$)|\$DATABASE_URL|scripts/db/'
if grep -qE "$DB_CLIENT" <<<"$CMD"; then
  MUTATION_PATTERNS=(
    '\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX|TYPE|VIEW|ROLE)\b'
    '\bTRUNCATE\b'
    '\bDELETE\s+FROM\b'
    '\bALTER\s+(TABLE|COLUMN|TYPE|INDEX|SCHEMA|ROLE)\b'
    '\bUPDATE\s+[a-zA-Z_."]+\s+SET\b'
    '\bINSERT\s+INTO\b'
    '\b(GRANT|REVOKE)\s'
  )
  for pat in "${MUTATION_PATTERNS[@]}"; do
    if grep -qEi "$pat" <<<"$CMD"; then
      ask "🟡 Database mutation through a database client: matches ${pat}. Review before proceeding. Command: ${CMD}"
    fi
  done
fi

echo '{}'
exit 0
