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
printf '  other:\n    container: ghcr.io/hatchet-dev/hatchet/hatchet-lite:v0.106.0\n' >> "${CI}"
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
printf '  e: { container: { image: %s:latest } }\n' "${IMG}" >> "${NEWEST}"
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
assert_exit "a workflow tag followed by a digest fails" 1 run_check
assert_last_output_contains "the digest line is named" ".github/workflows/ci.yml:6 names hatchet-lite with a digest; pin the tag alone"

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

every_tag v0.107.0-rc1
assert_exit "a compose default that is not a vX.Y.Z release fails even when every file agrees" 1 run_check
assert_last_output_contains "the compose release rule is named" "infra/hatchet/compose.yaml pins hatchet-lite:v0.107.0-rc1, not a vMAJOR.MINOR.PATCH release"

every_tag v0.107.0
printf 'services:\n  hatchet-lite:\n    image: x\n    environment:\n      ENGINE: %s:${KYU_HATCHET_IMAGE_TAG:-v0.107.0}\n' "${IMG}" > "${COMPOSE}"
assert_exit "a compose reference outside an image: value is not the engine image" 1 run_check
assert_last_output_contains "the compose environment line is named" "infra/hatchet/compose.yaml:5 names hatchet-lite in a layout this gate cannot read"

for good in "\"${IMG}:v0.107.0\"" "'${IMG}:v0.107.0'" "[${IMG}:v0.107.0]" "{ image: ${IMG}:v0.107.0 }" "{image: ${IMG}:v0.107.0}" "${IMG}:v0.107.0 # note"; do
  every_tag v0.107.0
  printf 'x: %s\n' "${good}" >> "${CI}"
  assert_exit "a reference written ${good} passes" 0 run_check
done

# --- Layouts a line scanner misread: the gate reads the parsed values ---
every_tag v0.107.0
cat > "${TREE}/.github/workflows/escaped.yml" <<'YAML'
jobs:
  t:
    services:
      e:
        image: "ghcr.io/hatchet-dev/hatchet/hatchet\x2dlite:latest"
YAML
assert_exit "a reference written with a YAML escape is read" 1 run_check
assert_last_output_contains "the escaped reference is named" ".github/workflows/escaped.yml pins hatchet-lite:latest"

every_tag v0.107.0
cat > "${TREE}/.github/workflows/joined.yml" <<'YAML'
jobs:
  t:
    steps:
      - run: "docker pull ghcr.io/hatchet-dev/hatchet/hatchet-\
          lite:latest"
YAML
assert_exit "a reference split by an escaped line break is read" 1 run_check
assert_last_output_contains "the joined reference is named" ".github/workflows/joined.yml pins hatchet-lite:latest"

every_tag v0.107.0
cat > "${TREE}/.github/workflows/block.yml" <<YAML
jobs:
  t:
    steps:
      - run: |
          echo pull
          # docker pull ${IMG}:latest
YAML
assert_exit "a run: block line that starts with # is still read" 1 run_check
assert_last_output_contains "the run: block line is named" ".github/workflows/block.yml pins hatchet-lite:latest, infra/hatchet/compose.yaml pins hatchet-lite:v0.107.0 (line 6)"

every_tag v0.107.0
printf 'x: ok # was %s:latest\n' "${IMG}" >> "${CI}"
assert_exit "a YAML comment after a value is ignored" 0 run_check

every_tag v0.107.0
sed -i.bak 's|:-v0.107.0}|:-v0.107.0}-rc1|' "${COMPOSE}" && rm "${COMPOSE}.bak"
assert_exit "text after the compose default fails" 1 run_check
assert_last_output_contains "the compose line is named" "infra/hatchet/compose.yaml:4 names hatchet-lite in a layout this gate cannot read"

every_tag v0.107.0
printf '  second:\n    image: "ghcr.io/hatchet-dev/hatchet/hatchet\\x2dlite:latest"\n' >> "${COMPOSE}"
assert_exit "an escaped second compose image fails" 1 run_check
assert_last_output_contains "the escaped compose line is named" "infra/hatchet/compose.yaml:6 names hatchet-lite in a layout this gate cannot read"

# --- A file the gate cannot read fails, with or without an engine in it ---
every_tag v0.107.0
printf 'jobs: [\n' > "${TREE}/.github/workflows/broken.yml"
assert_exit "a workflow that does not parse fails" 1 run_check
assert_last_output_contains "the broken workflow is named" ".github/workflows/broken.yml line 2 does not parse"

every_tag v0.107.0
printf -- '---\njobs: {}\n' >> "${CI}"
assert_exit "a workflow with two YAML documents fails" 1 run_check
assert_last_output_contains "the two documents are named" ".github/workflows/ci.yml holds 2 YAML documents"

every_tag v0.107.0
printf 'x-base: &base\n  runs-on: ubuntu-latest\nx-job:\n  <<: *base\n' >> "${CI}"
assert_exit "a workflow with a merge key fails" 1 run_check
assert_last_output_contains "the merge key is named" ".github/workflows/ci.yml line 12 uses a YAML merge key"

every_tag v0.107.0
printf 'services:\n  hatchet-lite:\n    image: ghcr.io/hatchet-dev/hatchet/hatchet-lite:${KYU_HATCHET_IMAGE_TAG:-v0.107.0}\n    image: x\n' > "${COMPOSE}"
assert_exit "a compose.yaml that does not parse fails" 1 run_check
assert_last_output_contains "the compose shape is restated" 'infra/hatchet/compose.yaml must name the engine only as hatchet-lite:${KYU_HATCHET_IMAGE_TAG:-<tag>}.'

every_tag v0.107.0
printf '%%TAG !e! tag:example.com,2000:\n---\njobs: {}\n' > "${TREE}/.github/workflows/tagged.yml"
assert_exit "a workflow with a %TAG directive fails" 1 run_check
assert_last_output_contains "the directive is named" ".github/workflows/tagged.yml uses a %YAML or %TAG directive"

every_tag v0.107.0
printf 'jobs: {}\n' > "${TREE}/.github/workflows/Upper.YML"
assert_exit "a workflow with an upper-case extension fails" 1 run_check
assert_last_output_contains "the upper-case file is named" "Upper.YML has a workflow extension in another letter case"

BARE="${TMP}/bare"
mkdir -p "${BARE}/scripts/gates" "${BARE}/scripts/lib"
cp "${SCRIPT_DIR}"/check-engine-image-tag.sh "${SCRIPT_DIR}"/check-engine-image-tag.mjs "${SCRIPT_DIR}"/workflow-yaml.mjs "${BARE}/scripts/gates/"
cp "${SCRIPT_DIR}"/../lib/require-yaml.sh "${BARE}/scripts/lib/"
every_tag v0.107.0
run_without_yaml() {
  ROOT_DIR="${TREE}" bash "${BARE}/scripts/gates/check-engine-image-tag.sh"
}
assert_exit "a gate that cannot resolve the yaml package fails" 1 run_without_yaml
assert_last_output_contains "the missing package is named with the fix" "the workflow reader stopped before it checked every file; the yaml package is missing, run pnpm install"

# newest-engine.yml may name the engine by the tag its pick job chose at run time, and nothing else.
WEEKLY="${TREE}/.github/workflows/newest-engine.yml"
RT='${{ needs.pick.outputs.tag }}'
# weekly_with <tag text>... — a newest-engine.yml with one service image per argument.
weekly_with() {
  printf 'jobs:\n  test:\n    services:\n' > "${WEEKLY}"
  local i=0 tag
  for tag in "$@"; do
    i=$((i + 1))
    printf '      e%s:\n        image: %s:%s\n' "${i}" "${IMG}" "${tag}" >> "${WEEKLY}"
  done
}

every_tag v0.107.0
weekly_with "${RT}"
assert_exit "newest-engine.yml with the run-time tag passes" 0 run_check

every_tag v0.107.0
weekly_with "${RT}" v0.107.0
assert_exit "newest-engine.yml with the run-time tag and the pinned tag passes" 0 run_check

every_tag v0.107.0
printf 'jobs:\n  test:\n    services:\n      e:\n        image: "%s:%s" # weekly\n' "${IMG}" "${RT}" > "${WEEKLY}"
assert_exit "a quoted run-time tag with a comment in newest-engine.yml passes" 0 run_check

for wrong in v0.106.0 v0.110.2 latest; do
  every_tag v0.107.0
  weekly_with "${RT}" "${wrong}"
  assert_exit "newest-engine.yml hard-coding ${wrong} beside the run-time tag fails" 1 run_check
  assert_last_output_contains "newest-engine.yml is named for ${wrong}" ".github/workflows/newest-engine.yml pins hatchet-lite:${wrong}, infra/hatchet/compose.yaml pins hatchet-lite:v0.107.0"
done

every_tag v0.107.0
weekly_with v0.106.0
assert_exit "newest-engine.yml hard-coding another tag alone fails" 1 run_check
assert_last_output_contains "newest-engine.yml names the hard-coded tag" ".github/workflows/newest-engine.yml pins hatchet-lite:v0.106.0"

every_tag v0.107.0
printf 'jobs:\n  t:\n    services:\n      e:\n        image: %s\n' "${IMG}" > "${WEEKLY}"
assert_exit "newest-engine.yml with an untagged image fails" 1 run_check
assert_last_output_contains "the untagged image is named" ".github/workflows/newest-engine.yml pins hatchet-lite:(none)"

for spelled in '${{needs.pick.outputs.tag}}' '${{ inputs.tag }}' '${{ needs.pick.outputs.newest }}' "${RT}-amd64" "${RT}"'${{ matrix.suffix }}' "${RT}@sha256:0123"; do
  every_tag v0.107.0
  weekly_with "${spelled}"
  assert_exit "newest-engine.yml with the tag ${spelled} fails" 1 run_check
  assert_last_output_contains "the ${spelled} line is named" ".github/workflows/newest-engine.yml:5 names hatchet-lite in a layout this gate cannot read"
done

for other in .github/workflows/engine-weekly.yml .github/workflows/old/newest-engine.yml .github/actions/newest-engine.yml .github/workflows/Newest-Engine.yml; do
  every_tag v0.107.0
  mkdir -p "$(dirname "${TREE}/${other}")"
  printf 'jobs:\n  t:\n    services:\n      e:\n        image: %s:%s\n' "${IMG}" "${RT}" > "${TREE}/${other}"
  assert_exit "the run-time tag in ${other} fails" 1 run_check
  assert_last_output_contains "${other} is named" "${other}:5 names hatchet-lite in a layout this gate cannot read"
done

every_tag v0.107.0
sed -i.bak "s|hatchet-lite:v0.107.0|hatchet-lite:${RT}|" "${CI}" && rm "${CI}.bak"
assert_exit "ci.yml using the run-time tag fails" 1 run_check
assert_last_output_contains "the ci.yml image line is named for the run-time tag" ".github/workflows/ci.yml:6 names hatchet-lite in a layout this gate cannot read"

# --- fly.toml names the engine once, as the image line after [build] (#55) ---
FLY_DECOY="[env]\n  ENGINE = '${IMG}:v0.107.0'\n"
# fly_body <text> — fly.toml from printf %b text.
fly_body() {
  printf '%b' "$1" > "${FLY}"
}

every_tag v0.107.0
fly_body "# ${IMG}:latest in a comment\nprimary_region = 'syd'\n\n[build]\n  # the engine\n  image = \"${IMG}:v0.107.0\"\n\n[env]\n  # hatchet-lite falls back to postgres\n  KIND = 'rabbitmq'\n"
assert_exit "fly.toml with comments around the [build] image line passes" 0 run_check

for build in "[build]\n  image = 'ghcr.io/other/engine:latest'\n${FLY_DECOY}" \
  "build = { image = 'docker.io/other/engine:latest' }\n${FLY_DECOY}" \
  "[build]\n  image = \"\"\"ghcr.io/hatchet-dev/hatchet/hatchet-\\\\\nlite:latest\"\"\"\n${FLY_DECOY}" \
  "[build]\n  image = \"ghcr.io/hatchet-dev/hatchet/hatchet\\\\u002dlite:latest\"\n${FLY_DECOY}" \
  "[build]\n  image = 'hatchet-lite:latest'\n${FLY_DECOY}" \
  "[build]\n  image = 'ghcr.io/hatchet-dev/hatchet/HATCHET-LITE:latest'\n${FLY_DECOY}" \
  "[build]\n  image = '${IMG}:v0.107.0@sha256:0123456789abcdef'\n" \
  "[build]\n  image = '${IMG}:v0.107.0'\n  dockerfile = 'Dockerfile'\n" \
  "[build]\n  image = '${IMG}:v0.107.0' # was hatchet-lite:latest\n" \
  "[env]\n  X = '1'\n[build]\n  image = '${IMG}:v0.107.0'\n[build.args]\n  A = 'b'\n" \
  "[build]\n\n[env]\n  image = '${IMG}:v0.107.0'\n"; do
  every_tag v0.107.0
  fly_body "${build}"
  assert_exit "fly.toml that sets the engine any other way fails: ${build}" 1 run_check
  assert_last_output_contains "the fly.toml layout is restated for: ${build}" "infra/hatchet/fly/fly.toml must set the engine on the line after [build], as image = '<registry>/hatchet-lite:<tag>', and nowhere else"
done

every_tag v0.107.0
fly_body "[build]\n  image = 'ghcr.io/other/engine:latest'\n${FLY_DECOY}"
assert_last_output_contains "the decoy line is named" "infra/hatchet/fly/fly.toml:4 names build, image or hatchet-lite, or holds an escape or multi-line string"

# --- A digest, a bare name or upper case in a YAML string fails (#55) ---
for spelled in "${IMG}:v0.107.0@sha256:0123" "${IMG}@sha256:0123" 'hatchet-lite:latest' 'hatchet-lite:v0.107.0' 'docker.io/x/my-hatchet-lite:latest' 'ghcr.io/hatchet-dev/hatchet/HATCHET-LITE:latest' 'ghcr.io/hatchet-dev/hatchet/Hatchet-Lite:v0.107.0'; do
  every_tag v0.107.0
  printf 'jobs:\n  t:\n    steps:\n      - run: docker pull %s\n' "${spelled}" > "${TREE}/.github/workflows/pull.yml"
  assert_exit "a run: line that pulls ${spelled} fails" 1 run_check
  assert_last_output_contains "the ${spelled} line is named" ".github/workflows/pull.yml:4 names hatchet-lite"
done

every_tag v0.107.0
printf 'jobs:\n  t:\n    services:\n      e:\n        image: "ghcr.io/hatchet-dev/hatchet/hatchet\\x2dLITE:latest"\n' > "${TREE}/.github/workflows/escaped-upper.yml"
assert_exit "an escaped upper-case reference fails" 1 run_check
assert_last_output_contains "the escaped upper-case line is named" ".github/workflows/escaped-upper.yml:5 names hatchet-lite in upper case"

every_tag v0.107.0
printf 'jobs:\n  t:\n    steps:\n      - run: |\n          echo "Hatchet-Lite: not ready"\n          echo "hatchet-lite never became ready"\n          echo "${{ job.services.hatchet-lite.id }}"\n' > "${TREE}/.github/workflows/prose.yml"
assert_exit "hatchet-lite in prose, or as a service name, passes" 0 run_check

assert_exit "an unknown argument fails" 1 bash "${CHECK}" --nope

assert_exit "the repository's four files agree" 0 env ROOT_DIR="${REPO_ROOT}" bash "${CHECK}"

gate_test_finish
