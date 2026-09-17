#!/usr/bin/env bash
# check-no-escape-hatches.sh — production source may not silence the type
# system or the linter. Tests are exempt; the rule is about shipped code.
#
# Blocked in packages/*/src and examples/*/src (excluding *.test.ts):
#   as any | as unknown as | @ts-ignore | @ts-expect-error | eslint-disable | oxlint-disable
#
# Env (tests): ROOT_DIR
set -euo pipefail
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "${ROOT_DIR}"
echo "=== no escape hatches ==="
PATTERN='as any\b|as unknown as\b|@ts-ignore|@ts-expect-error|eslint-disable|oxlint-disable'
HITS=""
if [ -d packages ]; then
  HITS="${HITS}$(grep -rnE --include='*.ts' --include='*.tsx' --include='*.mts' --exclude='*.test.ts' --exclude='*.test.tsx' --exclude-dir=node_modules --exclude-dir=dist "${PATTERN}" packages/*/src 2>/dev/null || true)"
fi
if [ -d examples ]; then
  EXAMPLE_HITS="$(grep -rnE --include='*.ts' --include='*.tsx' --include='*.mts' --exclude='*.test.ts' --exclude='*.test.tsx' --exclude-dir=node_modules --exclude-dir=dist "${PATTERN}" examples/*/src 2>/dev/null || true)"
  if [ -n "${EXAMPLE_HITS}" ]; then
    HITS="$(printf '%s\n%s' "${HITS}" "${EXAMPLE_HITS}")"
  fi
fi
HITS="$(printf '%s' "${HITS}" | sed '/^$/d')"
if [ -n "${HITS}" ]; then
  echo "FAIL: escape hatch in production source:" >&2
  printf '%s\n' "${HITS}" | sed 's/^/  /' >&2
  echo "Fix the type or the code. Do not silence the check." >&2
  exit 1
fi
echo "OK: no escape hatches in packages/*/src or examples/*/src."
