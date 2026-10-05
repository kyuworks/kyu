#!/usr/bin/env bash
# Unit tests for check-engine-image-tag.sh.
# Run: bash scripts/gates/check-engine-image-tag.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${REPO_ROOT}/scripts/lib/gate-test-lib.sh"
CHECK="${SCRIPT_DIR}/check-engine-image-tag.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
TREE="${TMP}/repo"
COMPOSE="${TREE}/infra/hatchet/compose.yaml"
FLY="${TREE}/infra/hatchet/fly/fly.toml"
CI="${TREE}/.github/workflows/ci.yml"
NEWEST="${TREE}/.github/workflows/newest-client.yml"

run_check() {
  ROOT_DIR="${TREE}" bash "${CHECK}"
}

compose_with_tag() {
  printf 'services:\n  hatchet-lite:\n    # keep in step with fly.toml\n    image: ghcr.io/hatchet-dev/hatchet/hatchet-lite:${KYU_HATCHET_IMAGE_TAG:-%s}\n' "$1" > "${COMPOSE}"
}
fly_with_tag() {
  printf "# Pinned image tag: %s\n[build]\n  image = 'ghcr.io/hatchet-dev/hatchet/hatchet-lite:%s'\n" "$1" "$1" > "${FLY}"
}
# workflow_with_tag <tag> <file>
workflow_with_tag() {
  printf 'jobs:\n  t:\n    runs-on: ubuntu-latest\n    services:\n      hatchet-lite:\n        image: ghcr.io/hatchet-dev/hatchet/hatchet-lite:%s\n    steps:\n      - run: docker logs "${{ job.services.hatchet-lite.id }}"\n' "$1" > "$2"
}
# every_tag <tag> — a tree where all four files pin <tag>.
every_tag() {
  rm -rf "${TREE}"
  mkdir -p "${TREE}/infra/hatchet/fly" "${TREE}/.github/workflows"
  compose_with_tag "$1"
  fly_with_tag "$1"
  workflow_with_tag "$1" "${CI}"
  workflow_with_tag "$1" "${NEWEST}"
}

echo "=== check-engine-image-tag tests ==="

every_tag v0.107.0
assert_exit "all four files on the same pinned tag pass" 0 run_check
assert_last_output_contains "the tag and every file are named" "hatchet-lite:v0.107.0 in infra/hatchet/compose.yaml infra/hatchet/fly/fly.toml .github/workflows/ci.yml .github/workflows/newest-client.yml"

every_tag v0.107.0
compose_with_tag v0.108.0
assert_exit "compose.yaml on another tag fails" 1 run_check
assert_last_output_contains "the fly.toml line names both files" "infra/hatchet/fly/fly.toml pins hatchet-lite:v0.107.0, infra/hatchet/compose.yaml pins hatchet-lite:v0.108.0"

every_tag v0.107.0
fly_with_tag v0.106.0
assert_exit "fly.toml on another tag fails" 1 run_check
assert_last_output_contains "fly.toml and compose.yaml are named" "infra/hatchet/fly/fly.toml pins hatchet-lite:v0.106.0, infra/hatchet/compose.yaml pins hatchet-lite:v0.107.0"

every_tag v0.107.0
workflow_with_tag v0.106.0 "${CI}"
assert_exit "ci.yml on another tag fails" 1 run_check
assert_last_output_contains "ci.yml and compose.yaml are named" ".github/workflows/ci.yml pins hatchet-lite:v0.106.0, infra/hatchet/compose.yaml pins hatchet-lite:v0.107.0"

every_tag v0.107.0
workflow_with_tag v0.106.0 "${NEWEST}"
assert_exit "newest-client.yml on another tag fails" 1 run_check
assert_last_output_contains "newest-client.yml and compose.yaml are named" ".github/workflows/newest-client.yml pins hatchet-lite:v0.106.0, infra/hatchet/compose.yaml pins hatchet-lite:v0.107.0"

every_tag v0.107.0
workflow_with_tag latest "${CI}"
assert_exit "latest in a workflow fails" 1 run_check
assert_last_output_contains "the latest tag is named" ".github/workflows/ci.yml pins hatchet-lite:latest"

every_tag v0.107.0
sed -i.bak 's|hatchet-lite:v0.107.0|hatchet-lite|' "${NEWEST}" && rm "${NEWEST}.bak"
assert_exit "a workflow image with no tag fails" 1 run_check
assert_last_output_contains "the missing tag is named" ".github/workflows/newest-client.yml pins hatchet-lite:(none)"

every_tag latest
assert_exit "all four on latest fail" 1 run_check
assert_last_output_contains "compose.yaml must pin a release" "infra/hatchet/compose.yaml pins hatchet-lite:latest, not a vMAJOR.MINOR.PATCH release"

every_tag v0.107.0
printf '      other:\n        image: ghcr.io/hatchet-dev/hatchet/hatchet-lite:v0.106.0\n' >> "${CI}"
assert_exit "a workflow with two different hatchet-lite images fails" 1 run_check
assert_last_output_contains "both tags are named" ".github/workflows/ci.yml pins more than one hatchet-lite tag: v0.106.0 (line 10), v0.107.0 (line 6)"

every_tag v0.107.0
workflow_with_tag v0.106.0 "${TREE}/.github/workflows/engine-latest.yml"
assert_exit "a third workflow with a hatchet-lite image is compared too" 1 run_check
assert_last_output_contains "the third workflow is named" ".github/workflows/engine-latest.yml pins hatchet-lite:v0.106.0"

every_tag v0.107.0
printf 'jobs:\n  t:\n    runs-on: ubuntu-latest\n' > "${TREE}/.github/workflows/release.yml"
assert_exit "a workflow with no engine is not compared" 0 run_check

for missing in infra/hatchet/compose.yaml infra/hatchet/fly/fly.toml .github/workflows/ci.yml .github/workflows/newest-client.yml; do
  every_tag v0.107.0
  rm "${TREE}/${missing}"
  assert_exit "a missing ${missing} fails" 1 run_check
  assert_last_output_contains "the missing ${missing} is named" "FAIL: ${missing} not found"
done

every_tag v0.107.0
printf 'services:\n  hatchet-lite:\n    image: ghcr.io/hatchet-dev/hatchet/hatchet-lite:v0.107.0\n' > "${COMPOSE}"
assert_exit "compose.yaml without the KYU_HATCHET_IMAGE_TAG default fails" 1 run_check
assert_last_output_contains "the expected compose shape is named" "infra/hatchet/compose.yaml:3 names hatchet-lite in a layout this gate cannot read"

every_tag v0.107.0
printf 'jobs:\n  t:\n    runs-on: ubuntu-latest\n' > "${CI}"
assert_exit "ci.yml with no hatchet-lite image fails" 1 run_check
assert_last_output_contains "the empty workflow is named" "no hatchet-lite image tag found in .github/workflows/ci.yml"

IMG=ghcr.io/hatchet-dev/hatchet/hatchet-lite

every_tag v0.107.0
mkdir -p "${TREE}/.github/workflows"
printf 'jobs:\n  t:\n    services:\n      e:\n        image: %s\n' "${IMG}" > "${TREE}/.github/workflows/third.yml"
assert_exit "an untagged image in a third workflow fails" 1 run_check
assert_last_output_contains "the untagged third workflow is named" ".github/workflows/third.yml pins hatchet-lite:(none)"

every_tag v0.107.0
printf '    container: %s:latest\n' "${IMG}" >> "${CI}"
assert_exit "a container: short form on latest in ci.yml fails" 1 run_check
assert_last_output_contains "ci.yml names both tags" ".github/workflows/ci.yml pins more than one hatchet-lite tag: latest (line 9), v0.107.0 (line 6)"

every_tag v0.107.0
printf '      e: { image: %s:latest }\n' "${IMG}" >> "${NEWEST}"
assert_exit "a flow mapping image on latest fails" 1 run_check
assert_last_output_contains "newest-client.yml is named for the flow mapping" ".github/workflows/newest-client.yml pins more than one hatchet-lite tag: latest (line 9), v0.107.0 (line 6)"

every_tag v0.107.0
printf 'jobs:\n  t:\n    strategy:\n      matrix:\n        engine: [%s:latest]\n' "${IMG}" > "${TREE}/.github/workflows/matrix.yml"
assert_exit "a matrix value on latest fails" 1 run_check
assert_last_output_contains "the matrix workflow is named" ".github/workflows/matrix.yml pins hatchet-lite:latest"

every_tag v0.107.0
printf '  second:\n    image: %s:latest\n' "${IMG}" >> "${COMPOSE}"
assert_exit "a second literal compose service fails" 1 run_check
assert_last_output_contains "compose.yaml and the line are named" "infra/hatchet/compose.yaml:6 names hatchet-lite in a layout this gate cannot read"

every_tag v0.107.0
mkdir -p "${TREE}/.github/actions/engine"
printf 'runs:\n  using: docker\n  image: docker://%s:latest\n' "${IMG}" > "${TREE}/.github/actions/engine/action.yml"
assert_exit "a docker action on latest fails" 1 run_check
assert_last_output_contains "the action is named" ".github/actions/engine/action.yml pins hatchet-lite:latest"

every_tag v0.107.0
printf 'jobs:\n  t:\n    steps:\n      - run: docker pull %s:latest\n' "${IMG}" > "${TREE}/.github/workflows/pull.yaml"
assert_exit "a run: script that pulls latest in a .yaml workflow fails" 1 run_check
assert_last_output_contains "the .yaml workflow is named" ".github/workflows/pull.yaml pins hatchet-lite:latest"

every_tag v0.107.0
printf 'jobs:\n  t:\n    services:\n      e:\n        image: %s:${{ matrix.tag }}\n' "${IMG}" > "${TREE}/.github/workflows/dyn.yml"
assert_exit "an image tag the gate cannot read fails" 1 run_check
assert_last_output_contains "the unreadable line is named" ".github/workflows/dyn.yml:5 names hatchet-lite in a layout this gate cannot read"

every_tag v0.107.0
sed -i.bak "s|hatchet-lite:v0.107.0|hatchet-lite:v0.107.0@sha256:0123456789abcdef|" "${CI}" && rm "${CI}.bak"
assert_exit "a workflow tag followed by a digest compares by its tag" 0 run_check

every_tag v0.107.0
printf '# was %s:latest\n' "${IMG}" >> "${CI}"
assert_exit "a comment that names latest is ignored" 0 run_check

every_tag v0.107.0
printf 'jobs:\n  t:\n    services:\n      e:\n        image: %s:v0.107.0${{ matrix.suffix }}\n' "${IMG}" > "${TREE}/.github/workflows/suffix.yml"
assert_exit "a matrix suffix after the tag in a third workflow fails" 1 run_check
assert_last_output_contains "the third workflow line is named" ".github/workflows/suffix.yml:5 names hatchet-lite in a layout this gate cannot read"

every_tag v0.107.0
sed -i.bak 's|hatchet-lite:v0.107.0|hatchet-lite:v0.107.0${{ matrix.suffix }}|' "${CI}" && rm "${CI}.bak"
assert_exit "a matrix suffix after the tag in ci.yml fails" 1 run_check
assert_last_output_contains "the ci.yml image line is named" ".github/workflows/ci.yml:6 names hatchet-lite in a layout this gate cannot read"

every_tag v0.107.0
printf 'jobs:\n  t:\n    steps:\n      - run: docker pull %s:v0.107.0$SUFFIX\n' "${IMG}" > "${TREE}/.github/workflows/pull.yml"
assert_exit "a shell suffix after the tag in run: text fails" 1 run_check
assert_last_output_contains "the run: line is named" ".github/workflows/pull.yml:4 names hatchet-lite in a layout this gate cannot read"

for bad in v0.107.0-rc1 v0.107.01; do
  every_tag v0.107.0
  workflow_with_tag "${bad}" "${CI}"
  assert_exit "a ${bad} tag fails" 1 run_check
  assert_last_output_contains "the ${bad} tag is named" ".github/workflows/ci.yml pins hatchet-lite:${bad}"
done

for good in "\"${IMG}:v0.107.0\"" "'${IMG}:v0.107.0'" "[${IMG}:v0.107.0]" "{ image: ${IMG}:v0.107.0 }" "{image: ${IMG}:v0.107.0}" "${IMG}:v0.107.0 # note"; do
  every_tag v0.107.0
  printf 'x: %s\n' "${good}" >> "${CI}"
  assert_exit "a reference written ${good} passes" 0 run_check
done

assert_exit "an unknown argument fails" 1 bash "${CHECK}" --nope

assert_exit "the repository's four files agree" 0 env ROOT_DIR="${REPO_ROOT}" bash "${CHECK}"

gate_test_finish
