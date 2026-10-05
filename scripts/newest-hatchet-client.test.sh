#!/usr/bin/env bash
# Self-test for newest-hatchet-client.sh. No network: every case passes NEWEST_CLIENT_VERSIONS.
# Run: bash scripts/newest-hatchet-client.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/gate-test-lib.sh"
PICKER="${SCRIPT_DIR}/newest-hatchet-client.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
echo "=== newest-hatchet-client tests ==="

# write_case dir range locked versions-json
write_case() {
  local dir="${WORK}/$1"
  mkdir -p "${dir}"
  printf '{ "dependencies": { "@hatchet-dev/typescript-sdk": "%s" } }\n' "$2" > "${dir}/package.json"
  printf "packages:\n\n  '@hatchet-dev/typescript-sdk@%s':\n    resolution: {integrity: sha512-x}\n\nsnapshots:\n\n  '@hatchet-dev/typescript-sdk@%s(@grpc/grpc-js@1.14.4)':\n    dependencies: {}\n" "$3" "$3" > "${dir}/pnpm-lock.yaml"
  printf '%s\n' "$4" > "${dir}/versions.json"
}

# pick dir [args...]
pick() {
  local dir="${WORK}/$1"
  shift
  NEWEST_CLIENT_SDK_PACKAGE="${dir}/package.json" NEWEST_CLIENT_LOCKFILE="${dir}/pnpm-lock.yaml" \
    NEWEST_CLIENT_VERSIONS="${dir}/versions.json" bash "${PICKER}" "$@"
}

LIST='["1.33.1","1.33.2","1.34.0-alpha.2","1.34.0","2.0.0"]'

write_case newer '^1.33.2' 1.33.2 "${LIST}"
assert_exit "picks the newest stable version inside the range" 0 pick newer
assert_last_output_contains "newest skips the pre-release and the next major" "newest=1.34.0"
assert_last_output_contains "reports the lockfile version" "lockfile=1.33.2"
assert_last_output_contains "reports the range" "range=^1.33.2"
assert_last_output_contains "tests when newest differs from the lockfile" "test=yes"

write_case same '^1.33.2' 1.34.0 "${LIST}"
assert_exit "newest equal to the lockfile exits 0" 0 pick same
assert_last_output_contains "newest equal to the lockfile skips the test" "test=no"
assert_exit "--force with newest equal to the lockfile exits 0" 0 pick same --force
assert_last_output_contains "--force tests anyway" "test=yes"

write_case numeric '^1.9.0' 1.9.0 '["1.9.0","1.10.0"]'
assert_output_contains "compares numerically, not as text" "newest=1.10.0" pick numeric

write_case prerelease '^1.33.2' 1.33.2 '["1.33.2","1.34.0-alpha.2"]'
assert_output_contains "a newer pre-release alone is not newer" "test=no" pick prerelease

write_case single '^1.33.2' 1.33.2 '"1.33.2"'
assert_output_contains "a single version printed as a string" "newest=1.33.2" pick single

write_case tilde '~1.33.2' 1.33.2 "${LIST}"
assert_exit "a tilde range fails" 1 pick tilde
assert_last_output_contains "a tilde range names the reason" "unsupported range ~1.33.2"

write_case zero '^0.5.0' 1.33.2 "${LIST}"
assert_exit "a caret on 0.x fails" 1 pick zero

write_case none '^3.0.0' 1.33.2 "${LIST}"
assert_exit "no version in range fails" 1 pick none
assert_last_output_contains "no version in range names the reason" "no stable @hatchet-dev/typescript-sdk version satisfies ^3.0.0"

write_case unlocked '^1.33.2' 1.33.2 "${LIST}"
printf 'packages:\n' > "${WORK}/unlocked/pnpm-lock.yaml"
assert_exit "a lockfile without the client fails" 1 pick unlocked
assert_last_output_contains "a lockfile without the client names the count" "found 0"

assert_exit "an unknown argument fails" 2 pick newer --bogus

# The default paths read this repository's own package.json and lockfile.
printf '%s\n' "${LIST}" > "${WORK}/repo-versions.json"
expected_range="$(node -p "require('${SCRIPT_DIR}/../packages/sdk/package.json').dependencies['@hatchet-dev/typescript-sdk']")"
assert_output_contains "reads the repository's range by default" "range=${expected_range}" \
  env NEWEST_CLIENT_VERSIONS="${WORK}/repo-versions.json" bash "${PICKER}"

gate_test_finish
