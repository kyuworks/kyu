#!/usr/bin/env bash
# Self-test for newest-hatchet-engine.sh. No network: a case passes NEWEST_ENGINE_TAGS, or runs
# the registry path with fetch replaced by newest-hatchet-engine.test.mock.mjs.
# Run: bash scripts/newest-hatchet-engine.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/gate-test-lib.sh"
PICKER="${SCRIPT_DIR}/newest-hatchet-engine.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
echo "=== newest-hatchet-engine tests ==="

# write_case dir pinned tags... (each tag one line of the registry list)
write_case() {
  local dir="${WORK}/$1" pinned="$2"
  shift 2
  mkdir -p "${dir}"
  printf 'services:\n  hatchet-lite:\n    # pinned\n    image: ghcr.io/hatchet-dev/hatchet/hatchet-lite:${KYU_HATCHET_IMAGE_TAG:-%s}\n' "${pinned}" > "${dir}/compose.yaml"
  if [ "$#" -gt 0 ]; then printf '%s\n' "$@" > "${dir}/tags.txt"; else : > "${dir}/tags.txt"; fi
}

# pick dir [args...]
pick() {
  local dir="${WORK}/$1"
  shift
  NEWEST_ENGINE_COMPOSE="${dir}/compose.yaml" NEWEST_ENGINE_TAGS="${dir}/tags.txt" bash "${PICKER}" "$@"
}

LIST=(latest v0.107.0 v0.107.0-amd64 v0.108.0 v0.110.2 v0.110.2-arm64 v0.111.0-alpha.0 v0.110.3-amd64 v.jun-27-demo.1 v0.110.0)

write_case newer v0.107.0 "${LIST[@]}"
assert_exit "picks the newest release tag" 0 pick newer
assert_last_output_contains "newest skips latest, alpha, arch-only and demo tags" "newest=v0.110.2"
assert_last_output_contains "reports the pinned tag" "pinned=v0.107.0"
assert_last_output_contains "tests when newest differs from the pinned tag" "test=yes"

write_case same v0.110.2 "${LIST[@]}"
assert_exit "newest equal to the pinned tag exits 0" 0 pick same
assert_last_output_contains "newest equal to the pinned tag skips the test" "test=no"
assert_exit "--force with newest equal to the pinned tag exits 0" 0 pick same --force
assert_last_output_contains "--force tests anyway" "test=yes"

write_case numeric v0.9.0 v0.9.0 v0.10.0
assert_output_contains "compares minor numerically, not as text" "newest=v0.10.0" pick numeric
write_case major v0.200.0 v0.200.0 v1.0.0 v0.999.999
assert_output_contains "a new major is newest" "newest=v1.0.0" pick major

write_case prerelease v0.107.0 v0.107.0 v0.108.0-alpha.1 v0.108.0-rc.1 v0.108.0-amd64 v0.108.0-arm64 latest
assert_output_contains "newer non-release tags alone are not newer" "test=no" pick prerelease

write_case empty v0.107.0
assert_exit "an empty list fails" 1 pick empty
assert_last_output_contains "an empty list names the reason" "the registry lists no vMAJOR.MINOR.PATCH tag"

write_case junk v0.107.0 latest '{"errors":[{"code":"UNAUTHORIZED"}]}' v0.107.0-amd64
assert_exit "a list with no release tag fails" 1 pick junk
assert_last_output_contains "a list with no release tag names the reason" "the registry lists no vMAJOR.MINOR.PATCH tag"

write_case partial v0.107.0 v0.108.0 v0.110.2
assert_exit "a list without the pinned tag fails" 1 pick partial
assert_last_output_contains "a list without the pinned tag names it" "the registry list lacks the pinned v0.107.0"

write_case latest-pin latest "${LIST[@]}"
assert_exit "compose pinning latest fails" 1 pick latest-pin
assert_last_output_contains "compose pinning latest names it" "pins latest, not a vMAJOR.MINOR.PATCH release"

write_case no-default v0.107.0 "${LIST[@]}"
printf 'services:\n  hatchet-lite:\n    image: ghcr.io/hatchet-dev/hatchet/hatchet-lite:v0.107.0\n' > "${WORK}/no-default/compose.yaml"
assert_exit "compose without the default fails" 1 pick no-default
assert_last_output_contains "compose without the default names the count" "found 0"

write_case two-defaults v0.107.0 "${LIST[@]}"
printf '  second:\n    image: ghcr.io/hatchet-dev/hatchet/hatchet-lite:${KYU_HATCHET_IMAGE_TAG:-v0.108.0}\n' >> "${WORK}/two-defaults/compose.yaml"
assert_exit "compose with two defaults fails" 1 pick two-defaults
assert_last_output_contains "compose with two defaults names the count" "found 2"

assert_exit "an unknown argument fails" 2 pick newer --bogus

# A registry tag is written to $GITHUB_OUTPUT: only a plain vX.Y.Z (no leading zeros) may reach it.
expected_stdout=$'pinned=v0.107.0\nnewest=v0.110.2\ntest=yes'
for hostile in 'v0.999.0;id' 'v0.999.0$(id)' 'v0.999.0 x' ' v0.999.0' 'v0.999.0=x' 'v00.999.0' 'v0.999.0"' '-v0.999.0' $'v0.999.0\r'; do
  write_case hostile v0.107.0 v0.107.0 v0.110.2 "${hostile}"
  actual_stdout="$(pick hostile 2>/dev/null)"
  assert_eq "ignores the registry tag $(printf '%q' "${hostile}")" "${expected_stdout}" "${actual_stdout}"
done

# --- A newest tag can have no image: the picker walks down to one that has ---
# write_manifests dir lines... (each "<tag> <http status>")
write_manifests() {
  local dir="${WORK}/$1"
  shift
  printf '%s\n' "$@" > "${dir}/manifests.txt"
}
# pick_m dir [args...] — pick with the manifest answers in dir/manifests.txt
pick_m() {
  local dir="${WORK}/$1"
  shift
  NEWEST_ENGINE_COMPOSE="${dir}/compose.yaml" NEWEST_ENGINE_TAGS="${dir}/tags.txt" NEWEST_ENGINE_MANIFESTS="${dir}/manifests.txt" bash "${PICKER}" "$@"
}

write_case noimage v0.107.0 "${LIST[@]}"
write_manifests noimage "v0.110.2 404"
assert_exit "a newest tag with no image is skipped" 0 pick_m noimage
assert_last_output_contains "the next release with an image is picked" "newest=v0.110.0"
assert_last_output_contains "the skipped tag is reported" "v0.110.2 has no image"
assert_last_output_contains "a skipped tag still tests the picked one" "test=yes"

write_manifests noimage "v0.110.2 404" "v0.110.0 404"
assert_output_contains "several tags in a row with no image are all skipped" "newest=v0.108.0" pick_m noimage

write_manifests noimage "v0.110.2 404" "v0.110.0 404" "v0.108.0 404"
assert_exit "every newer tag with no image exits 0" 0 pick_m noimage
assert_last_output_contains "nothing newer is the pinned tag" "newest=v0.107.0"
assert_last_output_contains "nothing newer does not test" "test=no"
assert_output_contains "--force still tests the pinned tag when nothing is newer" "test=yes" pick_m noimage --force

write_manifests noimage "v0.110.2 500"
assert_exit "a manifest check that answers 500 fails" 1 pick_m noimage
assert_last_output_contains "the 500 is named" "FAIL: ghcr.io manifest of v0.110.2: HTTP 500"
assert_output_lacks "a failed manifest check prints no test line" "test=" pick_m noimage

write_manifests noimage "v0.110.2 404" "v0.110.0 403"
assert_exit "a manifest check that answers 403 after a 404 fails" 1 pick_m noimage

write_manifests noimage "v0.106.0 500" "v0.108.0 200"
assert_output_contains "a tag older than the pinned one is never checked" "newest=v0.110.2" pick_m noimage

write_case capped v0.107.0 v0.107.0
for minor in $(seq 1 21); do printf 'v1.%s.0\n' "${minor}" >> "${WORK}/capped/tags.txt"; done
for minor in $(seq 1 21); do printf 'v1.%s.0 404\n' "${minor}"; done > "${WORK}/capped/manifests.txt"
assert_exit "more than 20 newer tags with no image fails" 1 pick_m capped
assert_last_output_contains "the cap is named" "the 20 newest release tags have no image"
sed -i.bak '/^v1.1.0 /d' "${WORK}/capped/manifests.txt" && rm "${WORK}/capped/manifests.txt.bak"
assert_output_contains "20 tags with no image and a 21st with one reaches the cap first" "the 20 newest release tags have no image" pick_m capped

# --- The registry calls, with fetch replaced by newest-hatchet-engine.test.mock.mjs ---
MOCK_FILE="${SCRIPT_DIR}/newest-hatchet-engine.test.mock.mjs"
write_case net v0.107.0
# net_pick mode [bash flags...] — the real network path against the mock
net_pick() {
  local mode="$1"
  shift
  NODE_OPTIONS="--import=${MOCK_FILE}" MOCK="${mode}" MOCK_NO_IMAGE="${MOCK_NO_IMAGE:-}" NEWEST_ENGINE_COMPOSE="${WORK}/net/compose.yaml" bash "$@" "${PICKER}"
}

assert_exit "a two-page listing picks the newest tag" 0 net_pick ok
assert_last_output_contains "the newest tag is on the second page" "newest=v0.110.2"
assert_last_output_contains "a two-page listing tests" "test=yes"
MOCK_NO_IMAGE=v0.110.2 assert_output_contains "a 404 manifest falls back to the next tag" "newest=v0.109.9" net_pick ok
MOCK_NO_IMAGE=v0.110.2 assert_last_output_contains "a 404 manifest is reported" "v0.110.2 has no image"

for case_ in \
  'token-401|ghcr.io pull token: HTTP 401' \
  'token-empty|ghcr.io pull token answer holds no token' \
  'list-401|ghcr.io tag list page 1: HTTP 401' \
  'list-500|ghcr.io tag list page 1: HTTP 500' \
  'not-json|ghcr.io tag list page 1 is not JSON' \
  'no-tags|ghcr.io tag list page 1 holds no tags array' \
  'loop|the tag list runs past 50 pages' \
  'link-absolute|ghcr.io tag list page 1 has a Link header this script cannot read' \
  'link-protocol|ghcr.io tag list page 1 has a Link header this script cannot read' \
  'throws|ghcr.io tag list page 1: connect ECONNREFUSED' \
  'manifest-500|ghcr.io manifest of v0.110.2: HTTP 500' \
  'manifest-throws|ghcr.io manifest of v0.110.2: connect ECONNRESET'; do
  mode="${case_%%|*}"
  assert_exit "the ${mode} registry answer fails" 1 net_pick "${mode}"
  assert_last_output_contains "the ${mode} answer prints one FAIL line" "FAIL: ${case_#*|}"
  assert_output_lacks "the ${mode} answer prints no stack trace" "    at " net_pick "${mode}"
  assert_output_lacks "the ${mode} answer prints no test line" "test=" net_pick "${mode}"
  assert_output_lacks "the ${mode} answer does not print the token under bash -x" "SECRETTOKEN123" net_pick "${mode}" -x
done
assert_output_lacks "a good run does not print the token under bash -x" "SECRETTOKEN123" net_pick ok -x

# The default path reads this repository's own compose file.
printf '%s\n' "${LIST[@]}" > "${WORK}/repo-tags.txt"
expected_pin="$(sed -nE 's|.*/hatchet-lite:\$\{KYU_HATCHET_IMAGE_TAG:-([^}]*)\}.*|\1|p' "${SCRIPT_DIR}/../infra/hatchet/compose.yaml")"
printf '%s\n' "${expected_pin}" >> "${WORK}/repo-tags.txt"
assert_output_contains "reads the repository's pinned tag by default" "pinned=${expected_pin}" \
  env NEWEST_ENGINE_TAGS="${WORK}/repo-tags.txt" bash "${PICKER}"

gate_test_finish
