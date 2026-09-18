#!/usr/bin/env bash
# Source this file — do not execute it. Defines resolve_base.
#
# Qtaxis has one long-lived branch: main. PRs land on main and there is no
# develop. Both detect-stage.sh and red2-worktree.sh need the same answer to
# "what do I measure this branch against?", so it lives in one function and
# cannot drift twice.
#
# resolve_base prints the ref to compare against on stdout — a remote-tracking
# ref such as origin/main, which merge-base, rev-list and diff all accept —
# and the rule that matched on stderr. Strip `origin/` for the report.
#
# A remote-tracking ref, not a local branch: a fresh clone or a cloud VM may
# have a stale local main, or none at all, while origin/main is right there.
#
# Order: origin/main, then whatever origin/HEAD points at, then origin/master,
# then a local branch (a purely local repository, as the test fixtures are).

resolve_base() {
  local name head
  if git rev-parse --verify --quiet "refs/remotes/origin/main" >/dev/null; then
    echo "resolve-base: origin/main exists" >&2
    printf 'origin/main\n'
    return 0
  fi
  head="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
  if [ -n "${head}" ] && git rev-parse --verify --quiet "refs/remotes/origin/${head}" >/dev/null; then
    echo "resolve-base: no origin/main; origin/HEAD points at ${head}" >&2
    printf 'origin/%s\n' "${head}"
    return 0
  fi
  for name in master; do
    if git rev-parse --verify --quiet "refs/remotes/origin/${name}" >/dev/null; then
      echo "resolve-base: no origin/main and no origin/HEAD; origin/${name} exists" >&2
      printf 'origin/%s\n' "${name}"
      return 0
    fi
  done
  # No remote at all — a purely local repository. Fall back to a local branch
  # rather than fail.
  for name in main master; do
    if git rev-parse --verify --quiet "refs/heads/${name}" >/dev/null; then
      echo "resolve-base: no remote refs; local ${name} exists" >&2
      printf '%s\n' "${name}"
      return 0
    fi
  done
  echo "resolve-base: nothing found; assuming main" >&2
  printf 'main\n'
}
