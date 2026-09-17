#!/usr/bin/env bash
# Unit tests for check-selftest-git-isolation.sh.
# Run: bash scripts/gates/check-selftest-git-isolation.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-selftest-git-isolation.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "=== check-selftest-git-isolation tests ==="

unisolated_body() {
  cat <<'SH'
#!/usr/bin/env bash
set -uo pipefail
root="$(mktemp -d)"
git -C "${root}" init -q
git -C "${root}" config user.email "fixture@test.local"
git -C "${root}" config user.name "fixture"
git -C "${root}" commit --allow-empty -qm "fixture"
rm -rf "${root}"
SH
}

isolated_body() {
  cat <<'SH'
#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../scripts/lib/git-env.sh"
unset "${GIT_HOOK_ENV_VARS[@]}"
root="$(mktemp -d)"
git -C "${root}" init -q
git -C "${root}" commit --allow-empty -qm "fixture"
rm -rf "${root}"
SH
}

quoted_only_body() {
  cat <<'SH'
#!/usr/bin/env bash
set -uo pipefail
# This suite only feeds a hypothetical command string to a decision table.
# It never actually runs the command, so it does not build a repository.
decision() { printf '%s' "$1"; }
result="$(decision 'git commit --no-verify -m x')"
printf '%s\n' "${result}"
SH
}

no_git_body() {
  cat <<'SH'
#!/usr/bin/env bash
set -uo pipefail
echo "no git here"
SH
}

# --- an unisolated repo-building suite fails the gate ---
mkdir -p "${WORK}/bad/scripts/gates"
unisolated_body > "${WORK}/bad/scripts/gates/fixture.test.sh"
assert_exit "unisolated repo-building suite fails" 1 env ROOT_DIR="${WORK}/bad" bash "${CHECK}"
assert_output_contains "failure names the offending file" "fixture.test.sh" \
  env ROOT_DIR="${WORK}/bad" bash "${CHECK}"

# --- the same suite passes once it sources scripts/lib/git-env.sh ---
mkdir -p "${WORK}/good/scripts/gates" "${WORK}/good/scripts/lib"
cp "${SCRIPT_DIR}/../lib/git-env.sh" "${WORK}/good/scripts/lib/git-env.sh"
isolated_body > "${WORK}/good/scripts/gates/fixture.test.sh"
assert_exit "isolated repo-building suite passes" 0 env ROOT_DIR="${WORK}/good" bash "${CHECK}"

# --- a suite that only quotes a git command as test input is not flagged ---
mkdir -p "${WORK}/quoted/scripts/hooks"
quoted_only_body > "${WORK}/quoted/scripts/hooks/fixture.test.sh"
assert_exit "quoted-only git text does not trip the gate" 0 env ROOT_DIR="${WORK}/quoted" bash "${CHECK}"

# --- a suite with no git at all passes ---
mkdir -p "${WORK}/none/scripts/gates"
no_git_body > "${WORK}/none/scripts/gates/fixture.test.sh"
assert_exit "no-git suite passes" 0 env ROOT_DIR="${WORK}/none" bash "${CHECK}"

# --- an empty tree (no *.test.sh anywhere) passes ---
mkdir -p "${WORK}/empty/scripts"
assert_exit "no suites at all passes" 0 env ROOT_DIR="${WORK}/empty" bash "${CHECK}"

gate_test_finish
