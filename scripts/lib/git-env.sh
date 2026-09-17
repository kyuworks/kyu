#!/usr/bin/env bash
# git-env.sh — the GIT_* variables git exports when it invokes a hook.
#
# They override `git -C <dir>`, so a *.test.sh that builds a throwaway
# fixture repository under mktemp resolves back into the real repository's
# .git when it runs from inside .husky/pre-commit. Source this file, then:
#   unset "${GIT_HOOK_ENV_VARS[@]}"
# before the first `git init` / `git -C <fixture> ...` call. One list, so
# every runner and every self-contained suite clears the same names.
#
# Used by: scripts/verify-self-tests.sh, scripts/lib/run-isolated-selftest.sh,
# and any *.test.sh that builds a git repository directly.
# Gate: scripts/gates/check-selftest-git-isolation.sh
GIT_HOOK_ENV_VARS=(
  GIT_DIR
  GIT_WORK_TREE
  GIT_INDEX_FILE
  GIT_OBJECT_DIRECTORY
  GIT_ALTERNATE_OBJECT_DIRECTORIES
  GIT_COMMON_DIR
  GIT_NAMESPACE
  GIT_PREFIX
)
