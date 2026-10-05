#!/usr/bin/env bash
# check-engine-image-tag.sh — the local stack, the Fly deployment and CI run the
# same hatchet-lite tag. The default in infra/hatchet/compose.yaml is the source
# of truth; fly.toml and every workflow with a hatchet-lite image must match it,
# and it must be a pinned vMAJOR.MINOR.PATCH, never latest.
#
# Env overrides (for tests):
#   ROOT_DIR — repo root to read (default: repo root)
#
# Usage:
#   bash scripts/gates/check-engine-image-tag.sh
set -euo pipefail
export LC_ALL=C
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
for arg in "$@"; do
  echo "FAIL: unknown argument: ${arg}" >&2
  exit 1
done
echo "=== Engine image tag ==="

COMPOSE=infra/hatchet/compose.yaml
FLY=infra/hatchet/fly/fly.toml
REQUIRED_WORKFLOWS=(.github/workflows/ci.yml .github/workflows/newest-client.yml)
COMPOSE_PATTERN='s|^[[:space:]]*image:[[:space:]]*[^[:space:]]*/hatchet-lite:\$\{KYU_HATCHET_IMAGE_TAG:-([^}]*)\}.*|\1|p'
FLY_PATTERN="s|^[[:space:]]*image[[:space:]]*=[[:space:]]*['\"][^'\"]*/hatchet-lite(:([^'\"]*))?['\"].*|\2|p"
WORKFLOW_PATTERN="s|^[[:space:]]*image:[[:space:]]*['\"]?[^[:space:]'\"]*/hatchet-lite(:([^[:space:]'\"]*))?.*|\2|p"

# $1 file relative to ROOT_DIR, $2 sed pattern. Prints the one tag the file pins; an untagged image reads as "(none)".
one_engine_tag() {
  local file="$1" tags
  if [ ! -f "${ROOT_DIR}/${file}" ]; then
    echo "FAIL: ${file} not found" >&2
    return 1
  fi
  tags="$(sed -nE "$2" "${ROOT_DIR}/${file}" | sed 's/^$/(none)/' | sort -u)"
  if [ -z "${tags}" ]; then
    echo "FAIL: no hatchet-lite image tag found in ${file}" >&2
    return 1
  fi
  if [ "$(printf '%s\n' "${tags}" | wc -l | tr -d ' ')" != "1" ]; then
    echo "FAIL: ${file} pins more than one hatchet-lite tag: $(printf '%s' "${tags}" | tr '\n' ' ')" >&2
    return 1
  fi
  printf '%s' "${tags}"
}

status=0
if ! COMPOSE_TAG="$(one_engine_tag "${COMPOSE}" "${COMPOSE_PATTERN}")"; then
  echo "${COMPOSE} must keep its image as hatchet-lite:\${KYU_HATCHET_IMAGE_TAG:-<tag>}." >&2
  exit 1
fi
if ! [[ "${COMPOSE_TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "FAIL: ${COMPOSE} pins hatchet-lite:${COMPOSE_TAG}, not a vMAJOR.MINOR.PATCH release" >&2
  exit 1
fi

files=("${FLY}" "${REQUIRED_WORKFLOWS[@]}")
for wf in "${ROOT_DIR}"/.github/workflows/*.yml "${ROOT_DIR}"/.github/workflows/*.yaml; do
  [ -f "${wf}" ] || continue
  rel="${wf#"${ROOT_DIR}"/}"
  case " ${REQUIRED_WORKFLOWS[*]} " in *" ${rel} "*) continue ;; esac
  if [ -n "$(sed -nE "${WORKFLOW_PATTERN}" "${wf}")" ]; then files+=("${rel}"); fi
done

for file in "${files[@]}"; do
  pattern="${WORKFLOW_PATTERN}"
  [ "${file}" = "${FLY}" ] && pattern="${FLY_PATTERN}"
  if ! tag="$(one_engine_tag "${file}" "${pattern}")"; then
    status=1
    continue
  fi
  if [ "${tag}" != "${COMPOSE_TAG}" ]; then
    echo "FAIL: ${file} pins hatchet-lite:${tag}, ${COMPOSE} pins hatchet-lite:${COMPOSE_TAG}" >&2
    status=1
  fi
done

if [ "${status}" -ne 0 ]; then
  echo "An engine upgrade changes the tag in all of these files together (docs/operations/kyu-engine-on-fly.md, Upgrade)." >&2
  exit 1
fi
echo "hatchet-lite:${COMPOSE_TAG} in ${COMPOSE} ${files[*]}"
