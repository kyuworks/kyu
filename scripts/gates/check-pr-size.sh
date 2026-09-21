#!/usr/bin/env bash
# check-pr-size.sh — net production additions vs merge base
#
# Limit 400 (PR_SIZE_MAX). Metric: added − deleted on production paths.
# A shrink (net ≤ 0) always passes.
#
# Not production:
#   generated  __generated__/  /generated/  *.generated.*
#   lockfile   pnpm-lock.yaml package-lock.json yarn.lock bun.lock bun.lockb
#   fixture    /fixtures/ /__fixtures__/ *.fixture.*
#   test       /__tests__/ /e2e/ *.test.* *.spec.* *.test.sh
#   docs       *.md *.snap
# Binary numstat (-	-) is skipped. Renames use git -M.
#
# Human hatch (agents must split instead):
#   1. Label the PR oversized-justified
#   2. This exact line in the PR body (20+ chars after the colon):
#        oversized-justified: <why this must land as one PR>
#   CI reads both from $GITHUB_EVENT_PATH. If PR_SIZE_LABELS or
#   PR_SIZE_BODY is set, the event is ignored so tests own labels/body.
#
# In a pull request (GITHUB_BASE_REF set) the base is the base branch as it is
# now — origin/<base>, or the merge ref's first parent. Commits that landed on
# the base branch after the pull request opened are not counted. --range is
# ignored in that case.
#
# Usage:
#   bash scripts/gates/check-pr-size.sh
#   bash scripts/gates/check-pr-size.sh --range origin/develop...HEAD
# Self-test: bash scripts/gates/check-pr-size.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${ROOT_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"

RANGE="${PR_SIZE_RANGE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --range)
      RANGE="${2:-}"
      shift 2
      ;;
    *)
      echo "FAIL: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "FAIL: git is not on PATH" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL: python3 is not on PATH" >&2
  exit 1
fi
if ! git -C "${ROOT_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FAIL: ${ROOT_DIR} is not a git work tree" >&2
  exit 1
fi

# The base sha recorded in a pull request event goes stale the moment the base
# branch moves, and three dots from it then count the base branch's own
# commits. In a pull request, measure from the base branch as it is now.
pr_base_commit() {
  [ -n "${GITHUB_BASE_REF:-}" ] || return 1
  if git -C "${ROOT_DIR}" rev-parse --verify --quiet "origin/${GITHUB_BASE_REF}^{commit}" >/dev/null 2>&1; then
    echo "origin/${GITHUB_BASE_REF}"
    return 0
  fi
  # CI checks out the merge ref, whose first parent is the base branch tip.
  # Restrict to GitHub's own pull-request merge ref: a plain branch whose tip
  # happens to be a merge commit (e.g. merging the base into the branch as a
  # workaround) must not take this path.
  if [[ "${GITHUB_REF:-}" == refs/pull/*/merge ]] \
    && git -C "${ROOT_DIR}" rev-parse --verify --quiet "HEAD^2^{commit}" >/dev/null 2>&1; then
    echo "HEAD^1"
    return 0
  fi
  return 1
}

DIFF_SPEC=""
if pr_base="$(pr_base_commit)"; then
  DIFF_SPEC="${pr_base}...HEAD"
elif [[ "${RANGE}" == *...* ]]; then
  from="${RANGE%%...*}"
  to="${RANGE#*...}"
  DIFF_SPEC="${from}...${to:-HEAD}"
elif [ -n "${RANGE}" ]; then
  DIFF_SPEC="${RANGE}...HEAD"
elif [ -n "${GITHUB_BASE_SHA:-}" ]; then
  DIFF_SPEC="${GITHUB_BASE_SHA}...HEAD"
else
  base=""
  for cand in origin/main main; do
    if git -C "${ROOT_DIR}" rev-parse --verify "${cand}" >/dev/null 2>&1; then
      base="$(git -C "${ROOT_DIR}" merge-base "${cand}" HEAD)"
      break
    fi
  done
  if [ -z "${base}" ]; then
    echo "OK: no merge base; skip production PR size."
    exit 0
  fi
  DIFF_SPEC="${base}"
fi

export ROOT_DIR DIFF_SPEC
exec python3 - <<'PY'
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(os.environ["ROOT_DIR"])
DIFF_SPEC = os.environ["DIFF_SPEC"]
LIMIT = os.environ.get("PR_SIZE_MAX", "400").strip()
HATCH_LABEL = "oversized-justified"
REASON_RE = re.compile(r"^oversized-justified:\s+(\S.{19,})\s*$", re.MULTILINE)
LOCKFILES = {
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
}
DIR_SKIP = {"__generated__", "generated", "fixtures", "__fixtures__", "__tests__", "e2e"}


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


if not LIMIT.isdigit() or int(LIMIT) < 1:
    fail("FAIL: PR_SIZE_MAX must be a positive integer")
LIMIT_N = int(LIMIT)


def git_diff_numstat() -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(ROOT), "diff", "-M", "--numstat", DIFF_SPEC],
            text=True,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as err:
        detail = (err.stderr or err.stdout or "").strip()
        fail(f"FAIL: git diff {DIFF_SPEC} failed" + (f": {detail}" if detail else ""))


def parse_numstat_line(line: str) -> tuple[str, str, str] | None:
    parts = line.split("\t")
    if len(parts) < 3:
        return None
    added, deleted = parts[0], parts[1]
    rest = parts[2:]
    if "=>" in rest:
        path = rest[-1]
    elif len(rest) > 1:
        path = rest[-1]
    elif " => " in rest[0]:
        path = rest[0].split(" => ", 1)[1]
    else:
        path = rest[0]
    return added, deleted, path


def is_production(path: str) -> bool:
    norm = path.replace("\\", "/").strip()
    if not norm:
        return False
    parts = [p for p in norm.split("/") if p]
    name = parts[-1] if parts else ""
    if name in LOCKFILES:
        return False
    if name.endswith((".md", ".snap")):
        return False
    if ".generated." in name:
        return False
    if any(p in DIR_SKIP for p in parts):
        return False
    if ".test." in name or ".spec." in name or name.endswith(".test.sh"):
        return False
    if ".fixture." in name:
        return False
    return True


def hatch() -> bool:
    labels: list[str] = []
    body = ""
    # Test overrides own the hatch; do not mix in $GITHUB_EVENT_PATH.
    if "PR_SIZE_LABELS" not in os.environ and "PR_SIZE_BODY" not in os.environ:
        event_path = os.environ.get("GITHUB_EVENT_PATH")
        if event_path and Path(event_path).is_file():
            try:
                event = json.loads(Path(event_path).read_text())
            except json.JSONDecodeError:
                event = {}
            pr = event.get("pull_request") or {}
            for item in pr.get("labels") or []:
                if isinstance(item, dict) and item.get("name"):
                    labels.append(str(item["name"]))
            if isinstance(pr.get("body"), str):
                body = pr["body"]
    extra = os.environ.get("PR_SIZE_LABELS", "")
    if extra:
        labels.extend(p.strip() for p in extra.replace("\n", ",").split(",") if p.strip())
    if "PR_SIZE_BODY" in os.environ:
        body = os.environ["PR_SIZE_BODY"]
    return HATCH_LABEL in labels and REASON_RE.search(body) is not None


rows: list[tuple[str, int, int]] = []
for raw in git_diff_numstat().splitlines():
    parsed = parse_numstat_line(raw)
    if parsed is None:
        continue
    added_s, deleted_s, path = parsed
    if added_s == "-" or deleted_s == "-":
        continue
    if not is_production(path):
        continue
    rows.append((path, int(added_s), int(deleted_s)))

added = sum(a for _, a, _ in rows)
deleted = sum(d for _, _, d in rows)
net = added - deleted

print(f"=== check-pr-size (limit {LIMIT_N}, {DIFF_SPEC}) ===")
print(f"production +{added} −{deleted} (net {net})")

if net <= LIMIT_N:
    print("OK: production PR size is within the limit.")
    sys.exit(0)

if hatch():
    print(
        f"OK: net {net} exceeds {LIMIT_N}; human hatch {HATCH_LABEL} accepted."
    )
    sys.exit(0)

print("", file=sys.stderr)
fail_lines = [
    f"FAIL: net production additions {net} (limit {LIMIT_N})",
]
for path, add, delete in sorted(rows, key=lambda r: r[1] - r[2], reverse=True):
    if add == 0 and delete == 0:
        continue
    fail_lines.append(f"  {path}  +{add} −{delete}")
fail_lines.extend(
    [
        "",
        "Generated files, lockfiles, fixtures, tests, and markdown do not count.",
        "Large deletes that shrink the tree do not fail.",
        "",
        "Split the pull request. A human may apply label oversized-justified",
        "and add this line to the PR body:",
        "",
        "  oversized-justified: <why this must land as one PR>",
        "",
        "Agents must not apply the label or write that line.",
    ]
)
fail("\n".join(fail_lines))
PY
