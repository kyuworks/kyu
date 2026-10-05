#!/usr/bin/env bash
# check-durable-wall-clock.sh — a durable handler body re-runs from the top on
# every retry and replay, so a wall-clock read there can differ between
# attempts. Read the time with `ctx.now()`, which replays from the durable log.
#
# Scope is the file: a production file under packages/*/src or examples/*/src
# that names `DurableHandlerContext` or `DurableContext`, or calls `.durable(`,
# may not contain `Date.now` (called or passed) or an argument-less `new Date()`,
# including one whose `)` is on the next line. Comment lines and a trailing
# `// ...` after code are skipped. Tests (`*.test.ts`, `__tests__/`) are exempt.
# A helper in another file is not followed: keep a durable body's helpers in its file.
#
# Env (tests): ROOT_DIR
set -euo pipefail
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "${ROOT_DIR}"
echo "=== no wall-clock read in a durable handler file ==="
DURABLE='DurableHandlerContext|DurableContext|\.durable\('
# POSIX awk: no \b, no [[:classes:]], so it reads the same under BSD awk and mawk.
CLOCK_AWK='
function clock(s) {
  return s ~ /Date\.now([^A-Za-z0-9_$]|$)/ || s ~ /new Date[ \t]*(\([ \t]*\)|$|[^A-Za-z0-9_$( \t])/
}
FNR == 1 { open = 0 }
{
  line = $0
  sub(/^[ \t]*\/\/.*$/, "", line)
  if (match(line, /[ \t]\/\//)) {
    prefix = substr(line, 1, RSTART - 1)
    if (prefix !~ /['\''"`]/) line = prefix
  }
  if (line ~ /^[ \t]*(\*|\/\*)/) line = ""
  if (line ~ /^[ \t]*$/) next
  if (open && line ~ /^[ \t]*\)/) print FILENAME ":" open ":" held
  open = 0
  if (clock(line)) print FILENAME ":" FNR ":" $0
  else if (line ~ /new Date[ \t]*\([ \t]*$/) { open = FNR; held = $0 }
}'
DIRS=()
for dir in packages/*/src examples/*/src; do
  if [ -d "${dir}" ]; then DIRS+=("${dir}"); fi
done
FILES=()
if [ "${#DIRS[@]}" -gt 0 ]; then
  rc=0
  LISTED="$(grep -rlE --include='*.ts' --include='*.tsx' --include='*.mts' --include='*.cts' --exclude='*.test.ts' --exclude='*.test.tsx' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=__tests__ "${DURABLE}" "${DIRS[@]}")" || rc=$?
  # grep exits 1 when no file matches; 2 means it could not read or run.
  if [ "${rc}" -gt 1 ]; then
    echo "FAIL: grep could not list durable handler files (exit ${rc})." >&2
    exit 1
  fi
  while IFS= read -r file; do
    if [ -n "${file}" ]; then FILES+=("${file}"); fi
  done <<< "${LISTED}"
fi
HITS=""
if [ "${#FILES[@]}" -gt 0 ]; then
  HITS="$(awk "${CLOCK_AWK}" "${FILES[@]}")"
fi
if [ -n "${HITS}" ]; then
  echo "FAIL: wall-clock read in a durable handler file:" >&2
  printf '%s\n' "${HITS}" | sed 's/^/  /' >&2
  echo "Read the time with ctx.now(), which replays from the durable log." >&2
  exit 1
fi
echo "OK: no wall-clock read in a durable handler file."
