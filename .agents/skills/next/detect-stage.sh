#!/usr/bin/env bash
# Detect which phase of the feature pipeline the current work is at.
# Prints KEY=VALUE lines. STAGE= is the decision; everything else is the evidence.
# Never fails the caller: unknown state resolves to STAGE=plan.

set -uo pipefail

ARGS="${*:-}"
emit() { printf '%s=%s\n' "$1" "$2"; }

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  emit STAGE plan; emit REASON "not a git repository"; exit 0
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO=$(git rev-parse --show-toplevel); cd "$REPO" || exit 0
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)

source "$HERE/../_pipeline/scripts/resolve-base.sh"
BASE_WHY=$(mktemp)
BASE_REF=$(resolve_base 2>"$BASE_WHY")
BASE_SOURCE=$(sed 's/^resolve-base: //' "$BASE_WHY"); rm -f "$BASE_WHY"
BASE="${BASE_REF#origin/}"

MERGE_BASE=$(git merge-base "$BASE_REF" HEAD 2>/dev/null || echo "")
AHEAD=$(git rev-list --count "$BASE_REF..HEAD" 2>/dev/null || echo 0)
DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

emit BRANCH "$BRANCH"; emit BASE "$BASE"; emit BASE_SOURCE "$BASE_SOURCE"
# The same variable scripts/hooks/agent-guard.sh reads. Skills read this line, not the env.
if [ "${CLAUDE_CODE_REMOTE:-}" = true ]; then emit UNATTENDED yes; else emit UNATTENDED no; fi
emit COMMITS_AHEAD "$AHEAD"; emit DIRTY_FILES "$DIRTY"

# --- slug --------------------------------------------------------------------
# Branch slug first; then a distinctive word from the prompt matched against artifacts.

SLUG=""
case "$BRANCH" in
  feat/*|feature/*|fix/*|chore/*) SLUG="${BRANCH#*/}" ;;
esac

if [ -z "$SLUG" ] && [ -d planning-gitignored/plans ]; then
  for word in $(printf '%s' "$ARGS" | tr '[:upper:]' '[:lower:]' | tr -cs '[:alnum:]' ' '); do
    case "$word" in ????*) : ;; *) continue ;; esac
    case "$word" in plan|build|ship|test|prove|this|that|with|from|into|make|need|want|please|feature|issue|next|research|review|verify) continue ;; esac
    m=$(ls planning-gitignored/plans/*"$word"*.md 2>/dev/null | grep -v -- '-testing.md' | grep -v README | head -1)
    if [ -n "$m" ]; then SLUG=$(basename "$m" .md); break; fi
  done
fi
emit SLUG "${SLUG:-none}"

# --- artifacts ---------------------------------------------------------------

RESEARCH=none; PLAN=none; TESTPLAN=none
if [ -n "$SLUG" ]; then
  [ -d "planning-gitignored/research/$SLUG" ] && RESEARCH="planning-gitignored/research/$SLUG"
  [ -f "planning-gitignored/plans/$SLUG.md" ] && PLAN="planning-gitignored/plans/$SLUG.md"
  [ -f "planning-gitignored/plans/$SLUG-testing.md" ] && TESTPLAN="planning-gitignored/plans/$SLUG-testing.md"
fi
emit RESEARCH "$RESEARCH"; emit PLAN "$PLAN"; emit TESTPLAN "$TESTPLAN"

# Has RED₂ actually been recorded in the testing sub-plan?
RED2=no
[ "$TESTPLAN" != none ] && grep -qE 'RED-PROVEN|red2: ✓|RED₂ proven' "$TESTPLAN" 2>/dev/null && RED2=yes
emit RED2_RECORDED "$RED2"

# --- what kind of commits are on the branch ----------------------------------

# Kinesin test files: colocated *.test.ts, *.integration.test.ts, and the shell
# suites (*.test.sh) next to the gates and skill scripts.
TESTPAT='(^|/)(tests?|__tests__|spec)/|\.(test|spec)\.[jt]sx?$|\.integration\.test\.[jt]s$|\.test\.sh$'
# Where implementation lives: the workspace packages, the Hatchet deployment
# config, the repo scripts and gates, and the custom lint rules.
IMPLPAT='^(packages|infra|scripts|oxlint-rules)/'
# Planning, research and ADR commits are not code: anything under docs/ or any
# Markdown file anywhere.
DOCSPAT='^docs/|\.md$'
HAS_TESTS=no; HAS_IMPL=no; DOCS_ONLY=no
if [ "$AHEAD" -gt 0 ] 2>/dev/null && [ -n "$MERGE_BASE" ]; then
  CHANGED=$(git diff --name-only "$MERGE_BASE" HEAD 2>/dev/null)
  printf '%s\n' "$CHANGED" | grep -qE "$TESTPAT" && HAS_TESTS=yes
  printf '%s\n' "$CHANGED" | grep -vE "$TESTPAT" | grep -qE "$IMPLPAT" && HAS_IMPL=yes
  # Docs-only commits must not read as a started build.
  if printf '%s\n' "$CHANGED" | grep -qvE "$DOCSPAT"; then DOCS_ONLY=no; else DOCS_ONLY=yes; fi
fi
emit HAS_TEST_COMMITS "$HAS_TESTS"; emit HAS_IMPL_COMMITS "$HAS_IMPL"
emit DOCS_ONLY_COMMITS "${DOCS_ONLY:-no}"

# --- prompt signals ----------------------------------------------------------

ISSUE=$(printf '%s' "$ARGS" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
emit ISSUE "${ISSUE:-none}"

HINT=none
case "$(printf '%s' "$ARGS" | tr '[:upper:]' '[:lower:]')" in
  *"just research"*|*"research this"*|*"look into"*|*"investigate"*) HINT=research ;;
  *"just plan"*|*"only plan"*|*"plan this"*|*"plan it"*)             HINT=plan ;;
  *"create the issue"*|*"set up the base"*)                          HINT=prereq ;;
  *"just build"*|*"only build"*|*"build it"*|*"implement it"*)        HINT=build ;;
  *"just verify"*|*"run the tests"*|*"prove it"*)                    HINT=verify ;;
  *"just review"*|*"review it"*|*"review this"*)                     HINT=review ;;
  *"summarise"*|*"summarize"*|*"wrap up"*)                           HINT=wrap ;;
  *"open a pr"*|*"open the pr"*|*"raise a pr"*)                      HINT=open-pr ;;
esac
emit HINT "$HINT"

# --- pull request ------------------------------------------------------------

PR_NUMBER=none; PR_STATE=none; CI=none
if command -v gh >/dev/null 2>&1; then
  PR_JSON=$(gh pr view --json number,state,isDraft,statusCheckRollup 2>/dev/null)
  if [ -n "$PR_JSON" ]; then
    eval "$(printf '%s' "$PR_JSON" | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
states = []
for c in (d.get("statusCheckRollup") or []):
    states.append(str(c.get("conclusion") or c.get("state") or "").upper())
if not states: ci = "none"
elif any(s in ("FAILURE","TIMED_OUT","CANCELLED","ERROR","ACTION_REQUIRED") for s in states): ci = "failing"
elif any(s in ("PENDING","IN_PROGRESS","QUEUED","EXPECTED","") for s in states): ci = "pending"
else: ci = "passing"
print("PR_NUMBER=%s" % d.get("number","none"))
print("PR_STATE=%s" % ("draft" if d.get("isDraft") else str(d.get("state","none")).lower()))
print("CI=%s" % ci)
')"
  fi
fi
emit PR_NUMBER "$PR_NUMBER"; emit PR_STATE "$PR_STATE"; emit CI "$CI"

# --- decide ------------------------------------------------------------------
# Most-advanced state wins. An explicit hint overrides everything.

if [ "$HINT" != none ]; then
  emit STAGE "$HINT"; emit REASON "the prompt named the phase"; exit 0
fi

if [ "$PR_STATE" = open ] || [ "$PR_STATE" = draft ]; then
  case "$CI" in
    failing) emit STAGE fix;    emit REASON "PR #$PR_NUMBER open, CI red" ;;
    pending) emit STAGE wait;   emit REASON "PR #$PR_NUMBER open, CI still running" ;;
    *)       emit STAGE review; emit REASON "PR #$PR_NUMBER open, CI green" ;;
  esac
  exit 0
fi

if [ "$AHEAD" -gt 0 ] 2>/dev/null && [ "${DOCS_ONLY:-no}" != yes ]; then
  if [ "$RED2" = yes ]; then
    emit STAGE wrap;   emit REASON "RED₂ recorded in $TESTPLAN, no PR yet"
  elif [ "$HAS_IMPL" = yes ]; then
    emit STAGE verify; emit REASON "implementation committed on $BRANCH, RED₂ not yet recorded"
  elif [ "$HAS_TESTS" = yes ]; then
    emit STAGE build;  emit REASON "tests committed but no implementation — RED₁ is done"
  else
    emit STAGE build;  emit REASON "$AHEAD commit(s) on $BRANCH, nothing recognisable as tests or implementation"
  fi
  exit 0
fi

if [ "$PLAN" != none ] && [ "$TESTPLAN" != none ]; then
  emit STAGE prereq; emit REASON "both plan documents exist, no commits yet"; exit 0
fi

if [ "$PLAN" != none ]; then
  emit STAGE plan; emit REASON "engineering plan exists but $TESTPLAN is missing the testing sub-plan"; exit 0
fi

if [ "$RESEARCH" != none ]; then
  emit STAGE plan; emit REASON "research exists at $RESEARCH, no plan yet"; exit 0
fi

if [ -n "${ISSUE:-}" ]; then
  emit STAGE plan; emit REASON "issue #$ISSUE named, no plan documents found"; exit 0
fi

emit STAGE plan
emit REASON "no research, no plan, no commits beyond $BASE"
