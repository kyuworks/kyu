#!/usr/bin/env bash
# check-durable-wall-clock.sh — a durable handler body re-runs from the top on
# every retry and replay, so a wall-clock read there can differ between
# attempts. Read the time with `ctx.now()`, which replays from the durable log.
#
# Scope is the file: a production file under packages/*/src or examples/*/src
# that names `DurableHandlerContext` or `DurableContext`, or calls `.durable(`,
# may not contain `Date.now()` or an argument-less `new Date()`. Comment lines
# are skipped. Tests (`*.test.ts`, `__tests__/`) are exempt. A helper in
# another file is not followed: keep a durable body's helpers in its file.
#
# Env (tests): ROOT_DIR
set -euo pipefail
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "${ROOT_DIR}"
echo "=== no wall-clock read in a durable handler file ==="
DURABLE='DurableHandlerContext|DurableContext|\.durable\('
CLOCK='Date\.now\(|new Date\b[[:space:]]*(\([[:space:]]*\)|$|[^([:space:]])'
DIRS=()
for dir in packages/*/src examples/*/src; do
  if [ -d "${dir}" ]; then DIRS+=("${dir}"); fi
done
HITS=""
if [ "${#DIRS[@]}" -gt 0 ]; then
  while IFS= read -r file; do
    if [ -z "${file}" ]; then continue; fi
    found="$(grep -nE "${CLOCK}" "${file}" | grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' || true)"
    if [ -n "${found}" ]; then
      HITS="${HITS}$(printf '%s\n' "${found}" | sed "s|^|${file}:|")
"
    fi
  done < <(grep -rlE --include='*.ts' --include='*.tsx' --include='*.mts' --exclude='*.test.ts' --exclude='*.test.tsx' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=__tests__ "${DURABLE}" "${DIRS[@]}" 2>/dev/null || true)
fi
if [ -n "${HITS}" ]; then
  echo "FAIL: wall-clock read in a durable handler file:" >&2
  printf '%s' "${HITS}" | sed 's/^/  /' >&2
  echo "Read the time with ctx.now(), which replays from the durable log." >&2
  exit 1
fi
echo "OK: no wall-clock read in a durable handler file."
