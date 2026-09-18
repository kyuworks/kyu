#!/usr/bin/env bash
# RED₂ — prove the tests actually depend on the implementation.
#
# Builds a throwaway git worktree at the base commit, copies ONLY the test files
# from HEAD into it, and runs the suites there. They must fail. If they pass, the
# tests do not test the feature.
#
# Your working tree is never touched. Not by stash, not by checkout, not by revert.
# The only precondition is that your work is committed — which is also what makes
# it impossible to lose anything if this script dies half way.
#
# Usage:
#   red2-worktree.sh --cmd "pnpm --filter @qtaxis/sdk test" \
#                    [--cmd "pnpm --filter @qtaxis/sdk test:integration"] \
#                    [--base main] [--tests "glob,glob"] [--install] [--keep]
#
# The filter names the package the feature touched — @qtaxis/sdk or
# @qtaxis/schemas — and every --cmd must name the same package. Bare
# `pnpm vitest` fails from the root: vitest is installed per package. The
# integration suite (`test:integration`) is a script in packages/sdk and needs
# the local Hatchet stack from infra/hatchet/compose.yaml to be up
# (`pnpm hatchet:up`). Shell suites run with `bash <path>.test.sh`.
#
# Exit codes:
#   0  every suite failed          → RED₂ proven
#   1  some suite passed           → FALSE POSITIVE, the tests do not depend on the code
#   2  setup problem, or a command never ran a test → nothing was proven either way

set -uo pipefail

BASE=""
declare -a CMDS=()
TEST_GLOBS=""
INSTALL=0
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --cmd)     CMDS+=("$2"); shift 2 ;;
    --base)    BASE="$2"; shift 2 ;;
    --tests)   TEST_GLOBS="$2"; shift 2 ;;
    --install) INSTALL=1; shift ;;
    --keep)    KEEP=1; shift ;;
    *) echo "red2: unknown argument $1" >&2; exit 2 ;;
  esac
done

[ "${#CMDS[@]}" -gt 0 ] || { echo "red2: at least one --cmd is required" >&2; exit 2; }

git rev-parse --git-dir >/dev/null 2>&1 || { echo "red2: not a git repository" >&2; exit 2; }
REPO=$(git rev-parse --show-toplevel)
cd "$REPO" || exit 2
CLASSIFY="$REPO/.agents/skills/_pipeline/scripts/red2-classify.sh"

# --- preflight: a bare `pnpm <script>` must name something that can run ------
# Only the plain shape is checked. A --filter, -C, exec, or a compound command
# has too many shapes to reason about, and a false alarm here is worse than a
# missed one — the classifier still catches a command that never ran.

for cmd in "${CMDS[@]}"; do
  case "$cmd" in
    *--filter*|*" -C "*|*exec*|*"&&"*|*";"*|*"|"*) continue ;;
  esac
  read -ra words <<< "$cmd"
  [ "${words[0]:-}" = pnpm ] || continue
  # A leading flag is an option this preflight cannot reason about, not a script.
  case "${words[1]:-}" in -*) continue ;; esac
  S="${words[1]:-}"
  [ "$S" = run ] && S="${words[2]:-}"
  [ -n "$S" ] || continue
  if node -e 'process.exit(Object.hasOwn(require(process.argv[1]).scripts ?? {}, process.argv[2]) ? 0 : 1)' \
      "$REPO/package.json" "$S" 2>/dev/null; then
    continue
  fi
  [ -x "$REPO/node_modules/.bin/$S" ] && continue
  echo "red2: '$S' is not a script in the root package.json and not in node_modules/.bin" >&2
  echo "      Name the package: pnpm --filter @qtaxis/sdk $S" >&2
  exit 2
done

# --- precondition: everything committed -------------------------------------

if [ -n "$(git status --porcelain)" ]; then
  cat >&2 <<'MSG'
red2: the working tree is not clean.

RED₂ runs against committed state so that nothing can be lost. Commit first:

    git add -A && git commit -m "wip: before RED2"

Then re-run. This script will not stash, revert, or check out anything in your
working tree.
MSG
  exit 2
fi

# --- resolve base ------------------------------------------------------------

if [ -z "$BASE" ]; then
  source "$REPO/.agents/skills/_pipeline/scripts/resolve-base.sh"
  BASE=$(resolve_base)
elif git rev-parse --verify --quiet "refs/remotes/origin/$BASE" >/dev/null; then
  # `--base main` means the branch PRs land on, not a stale local copy of it.
  BASE="origin/$BASE"
fi
git rev-parse --verify --quiet "$BASE" >/dev/null || { echo "red2: base '$BASE' does not exist" >&2; exit 2; }

MERGE_BASE=$(git merge-base "$BASE" HEAD) || exit 2
echo "red2: base $BASE at $(git rev-parse --short "$MERGE_BASE")"

# --- classify changed files --------------------------------------------------

CHANGED=$(git diff --name-only "$MERGE_BASE" HEAD)
[ -n "$CHANGED" ] || { echo "red2: no changes between $BASE and HEAD — nothing to prove" >&2; exit 2; }

if [ -n "$TEST_GLOBS" ]; then
  PATTERN=$(printf '%s' "$TEST_GLOBS" | sed 's/,/|/g')
else
  # Qtaxis test files: colocated *.test.ts, *.integration.test.ts, and the
  # shell suites (*.test.sh) next to the gates and skill scripts.
  PATTERN='(^|/)(tests?|__tests__|spec)/|\.(test|spec)\.[jt]sx?$|\.integration\.test\.[jt]s$|\.test\.sh$'
fi

TESTS=$(printf '%s\n' "$CHANGED" | grep -E "$PATTERN")
IMPL=$(printf '%s\n' "$CHANGED" | grep -vE "$PATTERN")

if [ -z "$TESTS" ]; then
  echo "red2: no test files changed between $BASE and HEAD. Nothing to copy forward." >&2
  echo "      Changed files were:" >&2
  printf '        %s\n' $CHANGED >&2
  exit 2
fi

if [ -z "$IMPL" ]; then
  echo "red2: only test files changed — there is no implementation to remove." >&2
  exit 2
fi

echo "red2: $(printf '%s\n' "$TESTS" | wc -l | tr -d ' ') test file(s) kept, $(printf '%s\n' "$IMPL" | wc -l | tr -d ' ') implementation file(s) removed"
echo "red2: implementation being removed —"
printf '        %s\n' $IMPL

# --- build the worktree ------------------------------------------------------

WT="${TMPDIR:-/tmp}/red2-$(git rev-parse --short HEAD)-$$"
cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo "red2: worktree kept at $WT" >&2
  else
    git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1
    rm -rf "$WT" 2>/dev/null
  fi
}
trap cleanup EXIT

git worktree add --detach --quiet "$WT" "$MERGE_BASE" || { echo "red2: could not create worktree" >&2; exit 2; }
echo "red2: worktree at $WT"

# Copy the test files forward from HEAD. git show, not cp — the worktree must
# receive exactly what is committed, not whatever is on disk.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  mkdir -p "$WT/$(dirname "$f")"
  if ! git show "HEAD:$f" > "$WT/$f" 2>/dev/null; then
    echo "red2: could not copy $f forward (deleted at HEAD?), skipping" >&2
    rm -f "$WT/$f"
  fi
done <<< "$TESTS"

# --- dependencies ------------------------------------------------------------

if [ "$INSTALL" -eq 1 ]; then
  echo "red2: installing dependencies in the worktree"
  ( cd "$WT" && (pnpm install --frozen-lockfile || npm ci || npm install) ) || { echo "red2: install failed" >&2; exit 2; }
else
  # Symlink existing node_modules trees. Fast, and correct for pnpm because the
  # real packages live in the global store. Use --install if a suite misbehaves.
  find "$REPO" -maxdepth 4 -type d -name node_modules -not -path "*/node_modules/*" 2>/dev/null | while read -r nm; do
    rel="${nm#$REPO/}"
    mkdir -p "$WT/$(dirname "$rel")"
    ln -sfn "$nm" "$WT/$rel"
  done
  echo "red2: symlinked node_modules (use --install if a suite cannot resolve imports)"
fi

# --- run ---------------------------------------------------------------------

FAILED_AS_EXPECTED=0
PASSED_UNEXPECTEDLY=0
NOT_RUN=0
declare -a VERDICTS=()

for cmd in "${CMDS[@]}"; do
  echo
  echo "═══ red2: $cmd"
  out="$(mktemp)"
  ( cd "$WT" && eval "$cmd" ) >"$out" 2>&1
  rc=$?
  tail -40 "$out"
  # A non-zero exit is not proof on its own: pnpm exiting 1 on a missing
  # script looks the same as vitest exiting 1 on failed assertions.
  why="$(mktemp)"
  verdict="$(bash "$CLASSIFY" "$rc" "$out" 2>"$why")"
  reason="$(sed 's/^red2-classify: //' "$why")"
  rm -f "$out" "$why"
  case "$verdict" in
    FALSE-POSITIVE)
      echo "red2: ✗ PASSED without the implementation — FALSE POSITIVE ($reason)"
      VERDICTS+=("FALSE-POSITIVE  $cmd")
      PASSED_UNEXPECTEDLY=$((PASSED_UNEXPECTEDLY + 1)) ;;
    PROVEN)
      echo "red2: ✓ failed as expected ($reason)"
      VERDICTS+=("RED-PROVEN      $cmd")
      FAILED_AS_EXPECTED=$((FAILED_AS_EXPECTED + 1)) ;;
    *)
      echo "red2: ? no test ran — nothing proven ($reason)"
      VERDICTS+=("NOT-RUN         $cmd")
      NOT_RUN=$((NOT_RUN + 1)) ;;
  esac
done

echo
echo "═══ red2 summary"
printf '  %s\n' "${VERDICTS[@]}"
echo "  $FAILED_AS_EXPECTED proven, $PASSED_UNEXPECTEDLY false positive(s), $NOT_RUN not run"

# A run that could not execute its tests must never exit 0.
[ "$NOT_RUN" -eq 0 ] || exit 2
[ "$PASSED_UNEXPECTEDLY" -eq 0 ] || exit 1
