#!/usr/bin/env bash
# Unit tests for check-tsconfig-references.sh.
# Run: bash scripts/gates/check-tsconfig-references.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-tsconfig-references.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
echo "=== check-tsconfig-references tests ==="

write_workspace() {
  local root="$1"
  mkdir -p "${root}"
  cat > "${root}/pnpm-workspace.yaml" <<'YAML'
packages:
  - 'packages/*'
  - 'examples/*'
YAML
}

# --- Every package with a tsconfig.json is referenced -> pass ---
OK="${WORK}/ok"
write_workspace "${OK}"
mkdir -p "${OK}/packages/schemas" "${OK}/packages/sdk" "${OK}/packages/no-ts"
printf '{}\n' > "${OK}/packages/schemas/tsconfig.json"
printf '{}\n' > "${OK}/packages/sdk/tsconfig.json"
# packages/no-ts has no tsconfig.json: not a TypeScript package, not required.
cat > "${OK}/tsconfig.json" <<'JSON'
{ "files": [], "references": [{ "path": "packages/schemas" }, { "path": "packages/sdk" }] }
JSON
assert_exit "every referenced package passes" 0 env ROOT_DIR="${OK}" bash "${CHECK}"
assert_output_contains "pass message" "OK:" env ROOT_DIR="${OK}" bash "${CHECK}"

# --- A workspace package with a tsconfig.json missing from references -> fail ---
BAD="${WORK}/bad"
write_workspace "${BAD}"
mkdir -p "${BAD}/packages/schemas" "${BAD}/packages/sdk"
printf '{}\n' > "${BAD}/packages/schemas/tsconfig.json"
printf '{}\n' > "${BAD}/packages/sdk/tsconfig.json"
cat > "${BAD}/tsconfig.json" <<'JSON'
{ "files": [], "references": [{ "path": "packages/schemas" }] }
JSON
assert_exit "missing package reference fails" 1 env ROOT_DIR="${BAD}" bash "${CHECK}"
assert_output_contains "failure names the missing package" "packages/sdk" \
  env ROOT_DIR="${BAD}" bash "${CHECK}"

# --- examples/* is scanned the same way as packages/* ---
EXBAD="${WORK}/exbad"
write_workspace "${EXBAD}"
mkdir -p "${EXBAD}/packages/schemas" "${EXBAD}/examples/shop"
printf '{}\n' > "${EXBAD}/packages/schemas/tsconfig.json"
printf '{}\n' > "${EXBAD}/examples/shop/tsconfig.json"
cat > "${EXBAD}/tsconfig.json" <<'JSON'
{ "files": [], "references": [{ "path": "packages/schemas" }] }
JSON
assert_exit "missing example reference fails" 1 env ROOT_DIR="${EXBAD}" bash "${CHECK}"
assert_output_contains "failure names the missing example" "examples/shop" \
  env ROOT_DIR="${EXBAD}" bash "${CHECK}"

# --- No examples/ directory at all -> pass (matches this branch today) ---
NOEX="${WORK}/noex"
write_workspace "${NOEX}"
mkdir -p "${NOEX}/packages/schemas"
printf '{}\n' > "${NOEX}/packages/schemas/tsconfig.json"
cat > "${NOEX}/tsconfig.json" <<'JSON'
{ "files": [], "references": [{ "path": "packages/schemas" }] }
JSON
assert_exit "no examples/ directory still passes" 0 env ROOT_DIR="${NOEX}" bash "${CHECK}"

# --- Missing workspace or tsconfig file fails closed ---
NOWS="${WORK}/nows"
mkdir -p "${NOWS}"
cat > "${NOWS}/tsconfig.json" <<'JSON'
{ "files": [], "references": [] }
JSON
assert_exit "missing pnpm-workspace.yaml fails" 1 env ROOT_DIR="${NOWS}" bash "${CHECK}"

NOTS="${WORK}/nots"
write_workspace "${NOTS}"
assert_exit "missing root tsconfig.json fails" 1 env ROOT_DIR="${NOTS}" bash "${CHECK}"


# --- pnpm-workspace.yaml is read with the yaml package, not line by line ---
# write_case <dir> <all|schemas> <workspace text as a printf format>: packages/schemas and
# packages/sdk both hold a tsconfig.json; "schemas" leaves packages/sdk out of the references.
write_case() {
  CASE="${WORK}/$1"
  mkdir -p "${CASE}/packages/schemas" "${CASE}/packages/sdk"
  printf '{}\n' > "${CASE}/packages/schemas/tsconfig.json"
  printf '{}\n' > "${CASE}/packages/sdk/tsconfig.json"
  local refs='{ "path": "packages/schemas" }'
  [ "$2" = all ] && refs="${refs}, { \"path\": \"packages/sdk\" }"
  printf '{ "files": [], "references": [%s] }\n' "${refs}" > "${CASE}/tsconfig.json"
  printf -- "$3" > "${CASE}/pnpm-workspace.yaml"
}
run_case() { ROOT_DIR="${CASE}" bash "${CHECK}"; }

# reads_list <dir> <layout> <text>: the list is read, so the package left out fails.
reads_list() {
  write_case "$1" schemas "$3"
  assert_exit "$2: the unreferenced package fails" 1 run_case
  assert_last_output_contains "$2: the unreferenced package is named" "  - packages/sdk"
}
reads_list flow "a flow sequence" "packages: ['packages/*']\n"
reads_list keycomment "a comment after packages:" "packages: # the libraries\n  - 'packages/*'\n"
reads_list entrycomment "a comment after an entry" "packages:\n  - 'packages/*' # the libraries\n"
reads_list escaped "an escape in a double-quoted entry" 'packages:\n  - "packages/\\x2A"\n'
reads_list alias "an entry that is an alias" "x-libs: &libs packages/*\npackages:\n  - *libs\n"
reads_list folded "a folded block scalar entry" "packages:\n  - >-\n    packages/*\n"
reads_list plainpath "a path with no glob" "packages:\n  - packages/schemas\n  - packages/sdk\n"
reads_list listalias "a packages: value that is an alias" "x-list: &list\n  - 'packages/*'\npackages: *list\n"
reads_list crlf "CRLF line ends" "packages:\r\n  - 'packages/*'\r\n"

# fails_closed <dir> <layout> <text> <message>: every reference is present, the file still fails.
fails_closed() {
  write_case "$1" all "$3"
  assert_exit "$2 fails" 1 run_case
  assert_last_output_contains "$2: the reason is named" "$4"
}
fails_closed negated "a negated glob" "packages:\n  - 'packages/*'\n  - '!**/test/**'\n" \
  "pnpm-workspace.yaml line 3 has a packages: entry the gate cannot expand"
fails_closed deepglob "a glob other than <dir>/*" "packages:\n  - 'packages/**'\n" \
  "pnpm-workspace.yaml line 2 has a packages: entry the gate cannot expand"
fails_closed notext "an entry that is not text" "packages:\n  - { dir: 'packages/*' }\n" \
  "pnpm-workspace.yaml line 2 has a packages: entry the gate cannot expand"
fails_closed twokeys "a second packages: key" "packages:\n  - 'packages/*'\npackages:\n  - 'examples/*'\n" \
  "pnpm-workspace.yaml line 3 does not parse"
fails_closed twodocs "two YAML documents" "packages:\n  - 'packages/*'\n---\npackages:\n  - 'examples/*'\n" \
  "pnpm-workspace.yaml holds 2 YAML documents"
fails_closed tabs "a tab as indentation" "packages:\n\t- 'packages/*'\n" \
  "pnpm-workspace.yaml line 2 does not parse"
fails_closed tag "a YAML tag" "packages:\n  - !!str packages/*\n" \
  "pnpm-workspace.yaml line 2 has a YAML tag"
fails_closed nolist "no packages: key" "minimumReleaseAge: 10080\n" \
  "pnpm-workspace.yaml has no packages: list with an entry at the top level"
fails_closed emptylist "an empty packages: list" "packages: []\n" \
  "pnpm-workspace.yaml has no packages: list with an entry at the top level"
fails_closed uppercase "Packages: in another letter case" "Packages:\n  - 'packages/*'\n" \
  "pnpm-workspace.yaml has no packages: list with an entry at the top level"

# A settings-only line after the list, as the real file has, still reads the list.
write_case settings all "packages:\n  - 'packages/*'\nminimumReleaseAge: 10080\nallowBuilds:\n  esbuild: true\n"
assert_exit "a workspace file with settings after the list passes" 0 run_case

# --- The gate stops with an install hint when the yaml package cannot be resolved ---
BARE="${WORK}/bare"
mkdir -p "${BARE}/scripts/gates" "${BARE}/scripts/lib"
cp "${SCRIPT_DIR}"/check-tsconfig-references.sh "${SCRIPT_DIR}"/check-tsconfig-references.mjs "${SCRIPT_DIR}"/workflow-yaml.mjs "${BARE}/scripts/gates/"
cp "${SCRIPT_DIR}"/../lib/require-yaml.sh "${BARE}/scripts/lib/"
run_without_yaml() { ROOT_DIR="${OK}" bash "${BARE}/scripts/gates/check-tsconfig-references.sh"; }
assert_exit "a gate that cannot resolve the yaml package fails" 1 run_without_yaml
assert_last_output_contains "the missing package is named with the fix" "the yaml package is missing, run pnpm install"

assert_exit "the real repository passes" 0 bash "${CHECK}"

assert_exit "verify-gates registers the tsconfig references gate" 0 \
  grep -Fq 'bash scripts/gates/check-tsconfig-references.sh' "${SCRIPT_DIR}/../verify-gates.sh"

gate_test_finish
