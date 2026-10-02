#!/usr/bin/env bash
# check-no-pipe-to-grep-q.sh — no shell script pipes into a grep that stops early.
#
# grep -q, -m, -l and -L stop reading at the first match (or the count); a
# writer that still has text gets a broken pipe, and under pipefail the match
# reads as a miss. Read a here-string instead: grep -q PATTERN <<< "${text}".
# Output sent to /dev/null is allowed: GNU grep reads the pipe to its end then.
# There is no allow marker.
#
# Scans *.sh and extensionless sh/bash scripts (by shebang) under scripts/,
# .agents/, .husky/ and infra/. Single-quoted text, comments and heredoc bodies
# are data, not code. A line that ends in | carries the pipe to the next line;
# a line that ends in \ joins the next line.
# A file that ends with a quote, command substitution or heredoc still open
# fails: the scanner lost track and cannot vouch for the rest.
#
# Self-test: bash scripts/gates/check-no-pipe-to-grep-q.test.sh
# Env (tests): ROOT_DIR
set -euo pipefail
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "${ROOT_DIR}"
echo "=== no pipe into an early-exit grep ==="

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
        if (sq) { if (sq == 2 && c == "\\") i++; else if (c == "\047") sq = 0; out = out " "; continue }
        if (c == "<" && !dq && prev != "<" && heredoc == "" && substr(line, i, 3) ~ /^<<[^<]/) heredoc = delimiter_of(substr(line, i + 2))
        if (c == "\\") { if (i == n) cont = 1; out = out "  "; i++; prev = "x"; continue }
        if (dq) {
          if (c == "\"") dq = 0
          else if (c == "$" && substr(line, i + 1, 1) == "(") { depth++; inner[depth] = 0; dq = 0; out = out "$("; i++; prev = "("; continue }
          out = out c; prev = c; continue
        }
        if (c == "$" && substr(line, i + 1, 1) == "\047") { sq = 2; out = out "  "; i++; prev = "\047"; continue }
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
    function check_closed(file) {
      if (file != "" && (sq || dq || depth || heredoc != "" || in_body != ""))
        print "LOST " file ": the scanner lost track: a quote, command substitution or heredoc is still open at end of file"
    }
    FNR == 1 { check_closed(seen); seen = FILENAME; sq = 0; dq = 0; depth = 0; heredoc = ""; in_body = ""; carry = 0; cont = 0; held = "" }
    in_body {
      body_line = $0
      if (strip_tabs) sub(/^\t+/, "", body_line)
      if (body_line == in_body) in_body = ""
      next
    }
    {
      code = code_of($0)
      if (heredoc != "") { in_body = heredoc; heredoc = "" }
      code = held code; held = ""
      if (cont) { cont = 0; held = code; next }
      if (carry && code !~ /[^ \t]/) next
      staged = (carry ? "|" : "") code
      if (staged ~ /(^|[^|])[|]&?[ \t]*(command[ \t]+)?([^ \t|;&]*\/)?[ef]?grep([ \t]+-[^ \t]*)*[ \t]+(-[A-Za-z0-9]*[qmlL][A-Za-z0-9]*|--(quiet|silent|max-count(=[^ \t;&|)]*)?|files-with(out)?-match(es)?))([ \t;&|)]|$)/)
        print FILENAME ":" FNR ": " $0
      carry = (code ~ /(^|[^|])[|][ \t]*$/)
    }
    END { check_closed(seen) }
  ' "${FILES[@]}")"
fi

LOST="$(grep '^LOST ' <<< "${HITS}" || true)"
if [ -n "${LOST}" ]; then
  HITS="$(grep -v '^LOST ' <<< "${HITS}" || true)"
fi

if [ -n "${LOST}" ]; then
  echo "FAIL: a script could not be checked; simplify its quoting so the scanner can follow it:" >&2
  sed 's/^LOST /  /' <<< "${LOST}" >&2
  [ -n "${HITS}" ] && printf '%s\n' "${HITS}" | sed 's/^/  /' >&2
  exit 1
fi
if [ -n "${HITS}" ]; then
  echo "FAIL: a pipe feeds grep -q, -m, -l or -L; under pipefail an early exit breaks the writer and a match reads as a miss:" >&2
  printf '%s\n' "${HITS}" | sed 's/^/  /' >&2
  echo "Read a here-string instead: grep -q PATTERN <<< \"\${text}\"." >&2
  exit 1
fi
echo "OK: no script pipes into grep -q, -m, -l or -L."
