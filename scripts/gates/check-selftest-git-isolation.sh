#!/usr/bin/env bash
# check-selftest-git-isolation.sh — a *.test.sh that builds a git repository
# must clear the git hook env vars first, or a run outside
# scripts/verify-self-tests.sh (for example scripts/lib/run-isolated-selftest.sh,
# or a copy-paste straight from .husky/pre-commit) resolves `git -C <fixture>`
# into the real repository. This is the incident behind scripts/lib/git-env.sh:
# a throwaway repo under mktemp received real commits because GIT_DIR and
# GIT_INDEX_FILE from a hook invocation outlived the suite that built it.
#
# Rule: any *.test.sh under scripts/ or .agents/skills/ that runs, as a real
# shell command (not quoted inside a string, e.g. a fixture for a decision
# table), `git init`, `git -C <dir> init`, `git commit` (with or without -C),
# or `git worktree add` must also source scripts/lib/git-env.sh. Checked by
# grepping the suite for the literal fragment "git-env.sh" — the smallest
# check that still requires the fix to be in the file, not merely in a
# runner the file cannot see itself being called from. Single-quoted spans
# are stripped before matching so a suite that only *describes* a git
# command as test input (scripts/hooks/agent-guard.test.sh) is not flagged.
#
# Env (tests): ROOT_DIR
set -euo pipefail
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "${ROOT_DIR}"
echo "=== selftest git isolation ==="

REPO_BUILD_PATTERN='git( -C [^[:space:]]+)? +init\b|git( -C [^[:space:]]+)? +commit\b|git worktree add\b'

SEARCH_DIRS=()
for dir in scripts .agents/skills; do
  [ -d "${dir}" ] && SEARCH_DIRS+=("${dir}")
done

FAIL=0
if [ "${#SEARCH_DIRS[@]}" -gt 0 ]; then
  while IFS= read -r file; do
    [ -n "${file}" ] || continue
    stripped="$(sed -E "s/'[^']*'//g" "${file}")"
    printf '%s\n' "${stripped}" | grep -qE "${REPO_BUILD_PATTERN}" || continue
    if ! grep -q 'git-env\.sh' "${file}"; then
      echo "FAIL: ${file} builds a git repository but does not source scripts/lib/git-env.sh" >&2
      FAIL=1
    fi
  done < <(find "${SEARCH_DIRS[@]}" -name '*.test.sh' | sort)
fi

if [ "${FAIL}" -ne 0 ]; then
  echo "" >&2
  echo "Source scripts/lib/git-env.sh and unset \"\${GIT_HOOK_ENV_VARS[@]}\" before the" >&2
  echo "first git init / git -C <fixture> call." >&2
  exit 1
fi
echo "OK: every git-repo-building *.test.sh isolates itself."
