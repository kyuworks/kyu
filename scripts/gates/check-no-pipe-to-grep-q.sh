#!/usr/bin/env bash
# check-no-pipe-to-grep-q.sh — no shell script pipes a producer into grep -q.
#
# grep -q exits at its first match; a writer that still has text gets a broken
# pipe, and under pipefail the match reads as a miss (#19, #20). Read a
# here-string instead: grep -q PATTERN <<< "${text}". There is no allow marker.
#
# Scans *.sh and extensionless sh/bash scripts (by shebang) under scripts/,
# .agents/, .husky/ and infra/. Single-quoted text, comments and heredoc bodies
# are data, not code. A line that ends in | carries the pipe to the next line.
#
# Self-test: bash scripts/gates/check-no-pipe-to-grep-q.test.sh
# Env (tests): ROOT_DIR
set -euo pipefail
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "${ROOT_DIR}"
echo "=== no pipe into grep -q ==="

SHEBANG='^#!.*[/[:space:]](ba|da|z)?sh([[:space:]]|$)'
SEARCH_DIRS=()
for dir in scripts .agents .husky infra; do
  [ -d "${dir}" ] && SEARCH_DIRS+=("${dir}")
done

FILES=()
if [ "${#SEARCH_DIRS[@]}" -gt 0 ]; then
  while IFS= read -r file; do
    case "${file##*/}" in
      *.sh) FILES+=("${file}") ;;
      *.*) ;;
      *)
        first=""
        IFS= read -r first < "${file}" || true
        [[ "${first}" =~ ${SHEBANG} ]] && FILES+=("${file}")
        ;;
    esac
  done < <(find "${SEARCH_DIRS[@]}" \( -name node_modules -o -path .husky/_ \) -prune -o -type f -print | LC_ALL=C sort)
fi

HITS=""
if [ "${#FILES[@]}" -gt 0 ]; then
  HITS="$(awk '
    # The code of one line: single-quoted text and escaped characters blanked, the comment cut.
    function code_of(line,    out, i, n, c, prev) {
      out = ""; n = length(line); prev = " "
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (sq) { if (c == "\047") sq = 0; out = out " "; continue }
        if (c == "<" && prev != "<" && heredoc == "" && substr(line, i, 3) ~ /^<<[^<]/) heredoc = delimiter_of(substr(line, i + 2))
        if (c == "\\") { out = out "  "; i++; prev = "x"; continue }
        if (dq) {
          if (c == "\"") dq = 0
          else if (c == "$" && substr(line, i + 1, 1) == "(") { depth++; inner[depth] = 0; dq = 0; out = out "$("; i++; prev = "("; continue }
          out = out c; prev = c; continue
        }
        if (c == "\047") { sq = 1; out = out " "; prev = c; continue }
        if (c == "\"") dq = 1
        else if (c == "#" && prev ~ /[ \t;&|()]/) break
        else if (c == "(" && depth) inner[depth]++
        else if (c == ")" && depth) { if (inner[depth]) inner[depth]--; else { depth--; dq = 1 } }
        out = out c; prev = c
      }
      return out
    }
    function delimiter_of(rest) {
      strip_tabs = (substr(rest, 1, 1) == "-")
      sub(/^-?[ \t]*/, "", rest)
      gsub(/[\047"\\]/, "", rest)
      match(rest, /^[A-Za-z_][A-Za-z0-9_]*/)
      return RSTART ? substr(rest, 1, RLENGTH) : ""
    }
    FNR == 1 { sq = 0; dq = 0; depth = 0; heredoc = ""; in_body = ""; carry = 0 }
    in_body {
      body_line = $0
      if (strip_tabs) sub(/^\t+/, "", body_line)
      if (body_line == in_body) in_body = ""
      next
    }
    {
      code = code_of($0)
      if (heredoc != "") { in_body = heredoc; heredoc = "" }
      if (carry && code !~ /[^ \t]/) next
      staged = (carry ? "|" : "") code
      if (staged ~ /(^|[^|])[|]&?[ \t]*(command[ \t]+)?([^ \t|;&]*\/)?[ef]?grep([ \t]+-[^ \t]*)*[ \t]+(-[A-Za-z0-9]*q[A-Za-z0-9]*|--quiet|--silent)([ \t;&|)]|$)/)
        print FILENAME ":" FNR ": " $0
      carry = (code ~ /(^|[^|])[|][ \t]*$/)
    }
  ' "${FILES[@]}")"
fi

if [ -n "${HITS}" ]; then
  echo "FAIL: a pipe feeds grep -q; under pipefail an early exit breaks the writer and a match reads as a miss:" >&2
  printf '%s\n' "${HITS}" | sed 's/^/  /' >&2
  echo "Read a here-string instead: grep -q PATTERN <<< \"\${text}\"." >&2
  exit 1
fi
echo "OK: no script pipes into grep -q."
