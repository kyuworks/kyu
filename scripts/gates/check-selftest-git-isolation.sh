#!/usr/bin/env bash
# check-selftest-git-isolation.sh — a *.test.sh that builds a git repository
# must source scripts/lib/git-env.sh and unset "${GIT_HOOK_ENV_VARS[@]}"
# before the first git init/clone/commit/worktree-add (see scripts/lib/git-env.sh).
#
# The single-quote strip below is a heuristic for skipping quoted git-command
# text used as test input; each suite's own isolation is the real defence.
#
# Env (tests): ROOT_DIR
set -euo pipefail
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "${ROOT_DIR}"
echo "=== selftest git isolation ==="

REPO_BUILD_PATTERN='git( +-[cC] +[^[:space:]]+)* +(init|clone|commit|worktree +add)\b'

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
    if ! grep -qF 'unset "${GIT_HOOK_ENV_VARS[@]}"' "${file}"; then
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
