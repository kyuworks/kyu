#!/usr/bin/env bash
# Format-check the staged snapshot of each staged file, not the worktree copy.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
FILES="$(git diff --cached --name-only --diff-filter=ACMR | grep -E '\.(ts|tsx|mts|cts|json|css)$' | grep -v '^oxlint-rules/anti-slop/' | grep -v '/migrations/' || true)"
[ -n "${FILES}" ] || exit 0
while IFS= read -r f; do
  mkdir -p "${TMP}/$(dirname "${f}")"
  git show ":${f}" > "${TMP}/${f}"
done <<< "${FILES}"
cp .oxfmtrc.json "${TMP}/.oxfmtrc.json"
cp .oxfmtignore "${TMP}/.oxfmtignore" 2>/dev/null || true
cd "${TMP}"
# shellcheck disable=SC2086
"${ROOT_DIR}/node_modules/.bin/oxfmt" --check --ignore-path .oxfmtignore ${FILES}
