#!/usr/bin/env bash
# git-env.sh — the GIT_* variables that redirect git at a repository, which a hook invocation exports.
# GIT_AUTHOR_*/GIT_EXEC_PATH are left alone on purpose: a fixture's `git config user.*` may be harmlessly overridden by the committing human's identity under the hook.
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
