#!/usr/bin/env bash
# Unit tests for check-no-pipe-to-grep-q.sh.
# Run: bash scripts/gates/check-no-pipe-to-grep-q.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-no-pipe-to-grep-q.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "=== check-no-pipe-to-grep-q tests ==="

# fixture <case> <path under the case root>; the body comes on stdin.
fixture() {
  mkdir -p "$(dirname "${WORK}/$1/$2")"
  cat > "${WORK}/$1/$2"
}

run_case() {
  env ROOT_DIR="${WORK}/$1" bash "${CHECK}"
}

fixture printf-pipe scripts/fixture.sh <<'SH'
#!/usr/bin/env bash
printf '%s\n' "${text}" | grep -qE "${pattern}" && echo matched
SH
assert_exit "printf piped into grep -q fails" 1 run_case printf-pipe
assert_last_output_contains "the failure names file and line" "scripts/fixture.sh:2"

fixture grep-chain scripts/fixture.sh <<'SH'
#!/usr/bin/env bash
printf '%s\n' "${text}" | grep -vE "${skip}" | grep -qE "${pattern}" && echo matched
SH
assert_exit "grep -v piped into grep -q fails" 1 run_case grep-chain
assert_last_output_contains "the chained failure names file and line" "scripts/fixture.sh:2"

fixture here-string scripts/fixture.sh <<'SH'
#!/usr/bin/env bash
grep -qE "${pattern}" <<< "${text}" && echo matched
non_test="$(grep -vE "${skip}" <<< "${text}")"
grep -qE "${pattern}" <<< "${non_test}" && echo matched
SH
assert_exit "a here-string into grep -q passes" 0 run_case here-string

fixture file-read scripts/fixture.sh <<'SH'
#!/usr/bin/env bash
grep -qE "${pattern}" "${file}" && echo matched
[ -n "${a}" ] || grep -q "${pattern}" "${file}" || echo missing
SH
assert_exit "grep -q reading a file, and grep -q after ||, pass" 0 run_case file-read

fixture test-suite .agents/skills/x/fixture.test.sh <<'SH'
#!/usr/bin/env bash
if printf '%s' "${out}" | grep -qF 'needle'; then echo found; fi
SH
assert_exit "a .test.sh suite is checked too" 1 run_case test-suite
assert_last_output_contains "the suite failure names file and line" ".agents/skills/x/fixture.test.sh:2"

fixture next-line infra/fixture.sh <<'SH'
#!/usr/bin/env bash
printf '%s' "${target}" |
  grep -qE "${pattern}" ||
  echo missing
printf x |

  # a comment between the pipe and its reader
  grep -q y
SH
assert_exit "a pipe at the end of a line feeds grep -q on the next line" 1 run_case next-line
assert_last_output_contains "the next-line failure names the grep line" "infra/fixture.sh:3:"
assert_last_output_contains "a blank line and a comment do not end the pipe" "infra/fixture.sh:8:"

fixture spellings scripts/fixture.sh <<'SH'
#!/usr/bin/env bash
printf x | egrep -q y
printf x | command grep -q y
printf x | grep -Eq y
printf x | grep -i -qE y
printf x |grep --quiet y
ok="$(printf x | grep -qF y && echo yes)"
printf x | /usr/bin/grep -q y
SH
assert_exit "other spellings of grep -q fail" 1 run_case spellings
for line in 2 3 4 5 6 7 8; do
  assert_last_output_contains "spelling on line ${line} is named" "scripts/fixture.sh:${line}:"
done

fixture not-code scripts/fixture.sh <<'SH'
#!/usr/bin/env bash
# printf x | grep -q y
echo 'printf x | grep -q y'
cat <<'EOF'
printf x | grep -q y
EOF
grep -q y <<< word
printf x | grep -c y
SH
assert_exit "comments, single-quoted text, heredoc bodies and other grep flags pass" 0 run_case not-code

fixture after-here-string scripts/fixture.sh <<'SH'
#!/usr/bin/env bash
grep -q y <<< word
cat <<'EOF'
printf x | grep -q y
EOF
printf x | grep -q y
stripped="$(sed -E "s/'[^']*'//g" "${file}")"
printf x | grep -q y
SH
assert_exit "a here-string, a heredoc or nested quotes do not hide the lines after them" 1 run_case after-here-string
assert_last_output_contains "the line after the heredoc is named" "scripts/fixture.sh:6:"
assert_last_output_contains "the line after the nested quotes is named" "scripts/fixture.sh:8:"
assert_output_lacks "the heredoc body is not named" "scripts/fixture.sh:4:" run_case after-here-string

fixture shebang .husky/pre-commit <<'SH'
#!/bin/sh
git diff --cached --name-only | grep -q '\.sh$' && echo shell
SH
fixture shebang scripts/notes <<'SH'
printf x | grep -q y
SH
assert_exit "an extensionless sh script is checked by its shebang" 1 run_case shebang
assert_last_output_contains "the hook failure names file and line" ".husky/pre-commit:2"
assert_output_lacks "an extensionless file with no shebang is not checked" "scripts/notes" run_case shebang

fixture vendored scripts/node_modules/pkg/install.sh <<'SH'
#!/usr/bin/env bash
printf x | grep -q y
SH
fixture vendored .husky/_/pre-commit <<'SH'
#!/usr/bin/env sh
printf x | grep -q y
SH
assert_exit "node_modules and husky's generated .husky/_ are not scanned" 0 run_case vendored

fixture dq-heredoc scripts/fixture.sh <<'SH'
#!/usr/bin/env bash
echo "<<EOF"
printf x | grep -q y
SH
assert_exit "a << inside double quotes does not hide the lines after it" 1 run_case dq-heredoc
assert_last_output_contains "the pipe after a quoted << is named" "scripts/fixture.sh:3:"

fixture ansi-c scripts/fixture.sh <<'SH'
#!/usr/bin/env bash
echo $'it\'s' | grep -q s
SH
assert_exit "a dollar-quoted string with an escaped quote does not hide its own line" 1 run_case ansi-c
assert_last_output_contains "the pipe after a dollar-quoted string is named" "scripts/fixture.sh:2:"

fixture case-arm scripts/fixture.sh <<'SH'
#!/usr/bin/env bash
x="$(case "${y}" in
  a) echo "it's" ;;
esac)"
SH
assert_exit "a case arm inside a quoted command substitution fails closed" 1 run_case case-arm
assert_last_output_contains "the lost quoting is named" "still open at end of file"

fixture arithmetic-shift scripts/fixture.sh <<'SH'
#!/usr/bin/env bash
n=$(( a<<b ))
SH
assert_exit "a shift inside arithmetic fails closed" 1 run_case arithmetic-shift
assert_last_output_contains "the open heredoc is named" "scripts/fixture.sh: the scanner lost track"

fixture early-exit scripts/fixture.sh <<'SH'
#!/usr/bin/env bash
printf x | grep -m1 y
printf x | grep -m 1 y
printf x | grep --max-count=1 y
printf x | grep -l y
printf x | grep -L y
printf x | grep -il y
printf x | grep --files-with-matches y
printf x | grep --files-without-match y
SH
assert_exit "a pipe into grep -m, -l or -L fails" 1 run_case early-exit
for line in 2 3 4 5 6 7 8 9; do
  assert_last_output_contains "early-exit flag on line ${line} is named" "scripts/fixture.sh:${line}:"
done

fixture reads-all scripts/fixture.sh <<'SH'
#!/usr/bin/env bash
printf x | grep -c y
printf x | grep y >/dev/null
printf x | grep y > /dev/null 2>&1
printf x | grep y 1>/dev/null
printf x | grep y &>/dev/null
grep -m1 y "${file}"
grep -l y "${file}"
grep -m1 y <<< "${text}"
SH
assert_exit "grep that reads all its input, or reads a file or here-string, passes" 0 run_case reads-all

fixture continued scripts/fixture.sh <<'SH'
#!/usr/bin/env bash
printf x | grep \
  -q y
printf x \
  | grep -m1 y
grep -q y \
  "${file}"
SH
assert_exit "a pipe into grep -q split by a backslash-newline fails" 1 run_case continued
assert_last_output_contains "the continued -q pipe is named at its last line" "scripts/fixture.sh:3:"
assert_last_output_contains "the continued -m pipe is named at its last line" "scripts/fixture.sh:5:"
assert_output_lacks "a continued grep -q reading a file is not named" "scripts/fixture.sh:7:" run_case continued

mkdir -p "${WORK}/self/scripts/gates"
cp "${CHECK}" "${SCRIPT_DIR}/check-no-pipe-to-grep-q.test.sh" "${WORK}/self/scripts/gates/"
assert_exit "the gate and this suite pass their own check" 0 run_case self

assert_exit "the current tree stays green" 0 bash "${CHECK}"

gate_test_finish
