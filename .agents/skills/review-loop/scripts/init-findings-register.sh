#!/usr/bin/env bash
# Create or refresh the durable review register for the current workspace.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED="$SCRIPT_DIR/../assets/findings-register.seed.md"
if [[ -n "${REVIEW_REPO_ROOT:-}" ]]; then
  REPO_ROOT="$REVIEW_REPO_ROOT"
  WORKTREE_ROOT="$REVIEW_REPO_ROOT"
else
  # Every linked worktree of one clone shares the register beside the common .git.
  REPO_ROOT="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
  WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
fi

HEAD_SHA="${REVIEW_HEAD_SHA:-$(git -C "$WORKTREE_ROOT" rev-parse HEAD)}"
if [ "${REVIEW_BRANCH_NAME+x}" = x ]; then
  BRANCH="$REVIEW_BRANCH_NAME"
else
  BRANCH="$(git -C "$WORKTREE_ROOT" branch --show-current)"
fi

if [[ -z "$BRANCH" ]]; then
  BRANCH="detached"
fi

BRANCH_SLUG="$(printf '%s' "$BRANCH" | tr '/' '-' | tr -cs '[:alnum:]_.-' '-')"
REGISTER_REL=".artifacts/reviews/$BRANCH_SLUG/findings-register.md"
REGISTER="$REPO_ROOT/$REGISTER_REL"
mkdir -p "$(dirname "$REGISTER")"

if [[ ! -e "$REGISTER" ]]; then
  cp "$SEED" "$REGISTER"
fi

if [[ -n "${REVIEW_SCOPE_STATE:-}" ]]; then
  SCOPE_STATE="$REVIEW_SCOPE_STATE"
elif [[ -n "$(git -C "$WORKTREE_ROOT" status --porcelain --untracked-files=normal)" ]]; then
  SCOPE_STATE="HEAD plus worktree changes"
else
  SCOPE_STATE="clean"
fi

TEMP_FILE="$(mktemp "$(dirname "$REGISTER")/.findings-register.XXXXXX")"
trap 'rm -f "$TEMP_FILE"' EXIT
awk \
  -v register_path="$REGISTER_REL" \
  -v head_sha="$HEAD_SHA" \
  -v scope_state="$SCOPE_STATE" '
    { line[NR] = $0 }
    /^(Review mode|Artifact type|Register path|Reviewed head SHA|Reviewed scope state|Closeout state|Pull request):/ { anchor = NR }
    /^Register path:/ { line[NR] = "Register path: " register_path; seen["Register path"] = 1 }
    /^Reviewed head SHA:/ { line[NR] = "Reviewed head SHA: " head_sha; seen["Reviewed head SHA"] = 1 }
    /^Reviewed scope state:/ { line[NR] = "Reviewed scope state: " scope_state; seen["Reviewed scope state"] = 1 }
    /^Closeout state:/ {
      closeout = $0
      sub(/^Closeout state:[[:space:]]*/, "", closeout)
      if (closeout == "") closeout = "active"
      line[NR] = "Closeout state: " closeout
      seen["Closeout state"] = 1
    }
    END {
      value["Register path"] = register_path
      value["Reviewed head SHA"] = head_sha
      value["Reviewed scope state"] = scope_state
      value["Closeout state"] = "active"
      order[1] = "Register path"
      order[2] = "Reviewed head SHA"
      order[3] = "Reviewed scope state"
      order[4] = "Closeout state"
      if (NR == 0) {
        for (k = 1; k <= 4; k++) print order[k] ": " value[order[k]]
        exit
      }
      if (anchor == 0) anchor = NR
      for (i = 1; i <= NR; i++) {
        print line[i]
        if (i == anchor)
          for (k = 1; k <= 4; k++)
            if (!(order[k] in seen)) print order[k] ": " value[order[k]]
      }
    }
  ' "$REGISTER" > "$TEMP_FILE"
mv "$TEMP_FILE" "$REGISTER"
trap - EXIT

# Absolute: a caller in a linked worktree cannot resolve a clone-root-relative path.
printf '%s\n' "$REGISTER"
