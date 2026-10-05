#!/usr/bin/env bash
# check-engine-image-tag.sh — the local stack, the Fly deployment and CI run the
# same hatchet-lite tag. The default in infra/hatchet/compose.yaml is the source
# of truth; it must be a pinned vMAJOR.MINOR.PATCH, never latest.
#
# Every non-comment line under .github/ (*.yml, *.yaml: workflows and actions)
# that names /hatchet-lite counts as a reference, whatever its layout: a service
# image, a container: short form, a flow mapping, a matrix value, or text in a
# run: script. Its tag (a digest after the tag is ignored) must equal the compose
# default. A line whose tag cannot be read fails, naming the file and line. In
# compose.yaml every such line must be hatchet-lite:${KYU_HATCHET_IMAGE_TAG:-<tag>}.
# ci.yml, newest-client.yml and fly.toml must exist and each name the engine.
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

# $1 file. Prints "<line><TAB><text>" for each non-comment line naming /hatchet-lite.
reference_lines() {
  awk '/^[[:space:]]*#/ { next } index($0, "/hatchet-lite") { print NR "\t" $0 }' "$1"
}

# stdin: one line of text. Prints the tag of each hatchet-lite reference on it.
reference_tags() {
  awk '{
    s = $0
    while ((i = index(s, "/hatchet-lite")) > 0) {
      r = substr(s, i + 13)
      if (substr(r, 1, 1) == ":") {
        if (match(r, /^:[A-Za-z0-9._-]+/)) {
          t = substr(r, 2, RLENGTH - 1)
          n = substr(r, RLENGTH + 1, 1)
          if (n != "" && index(" \t\"\047@,]}#", n) == 0) t = "(unreadable)"
        } else t = "(unreadable)"
      } else if (r ~ /^[A-Za-z0-9_.-]/) t = "(unreadable)"
      else t = "(none)"
      print t
      s = r
    }
  }'
}

# $1 file relative to ROOT_DIR, $2 compose|other. Prints "<tag> <line of the first reference>"
# when every reference reads to one tag; otherwise explains on stderr and returns 1.
one_engine_tag() {
  local file="$1" kind="$2" n text t ref refs="" first="" bad=0 tags
  if [ ! -f "${ROOT_DIR}/${file}" ]; then
    echo "FAIL: ${file} not found" >&2
    return 1
  fi
  while IFS=$'\t' read -r n text; do
    [ -n "${n}" ] || continue
    if [ "${kind}" = compose ]; then
      t="$(printf '%s\n' "${text}" | sed -nE "${COMPOSE_PATTERN}")"
      [ -n "${t}" ] || t="(unreadable)"
    else
      t="$(printf '%s\n' "${text}" | reference_tags)"
    fi
    for ref in ${t}; do
      if [ "${ref}" = "(unreadable)" ]; then
        echo "FAIL: ${file}:${n} names hatchet-lite in a layout this gate cannot read" >&2
        bad=1
      fi
      refs="${refs}${ref}"$'\t'"${n}"$'\n'
      [ -n "${first}" ] || first="${n}"
    done
  done < <(reference_lines "${ROOT_DIR}/${file}")
  if [ -z "${refs}" ]; then
    echo "FAIL: no hatchet-lite image tag found in ${file}" >&2
    return 1
  fi
  [ "${bad}" -eq 0 ] || return 1
  tags="$(printf '%s' "${refs}" | awk -F'\t' '!seen[$1]++' | sort)"
  if [ "$(printf '%s\n' "${tags}" | wc -l | tr -d ' ')" != "1" ]; then
    echo "FAIL: ${file} pins more than one hatchet-lite tag: $(printf '%s\n' "${tags}" | awk -F'\t' '{ printf "%s%s (line %s)", sep, $1, $2; sep = ", " }')" >&2
    return 1
  fi
  printf '%s %s' "${tags%%$'\t'*}" "${first}"
}

status=0
if ! COMPOSE_OUT="$(one_engine_tag "${COMPOSE}" compose)"; then
  echo "${COMPOSE} must name the engine only as hatchet-lite:\${KYU_HATCHET_IMAGE_TAG:-<tag>}." >&2
  exit 1
fi
COMPOSE_TAG="${COMPOSE_OUT%% *}"
if ! [[ "${COMPOSE_TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "FAIL: ${COMPOSE} pins hatchet-lite:${COMPOSE_TAG}, not a vMAJOR.MINOR.PATCH release" >&2
  exit 1
fi

files=("${COMPOSE}" "${FLY}" "${REQUIRED_WORKFLOWS[@]}")
if [ -d "${ROOT_DIR}/.github" ]; then
  while IFS= read -r found; do
    rel="${found#"${ROOT_DIR}"/}"
    case " ${files[*]} " in *" ${rel} "*) continue ;; esac
    if [ -n "$(reference_lines "${found}")" ]; then files+=("${rel}"); fi
  done < <(find "${ROOT_DIR}/.github" -type f \( -name '*.yml' -o -name '*.yaml' \) | sort)
fi

for file in "${files[@]:1}"; do
  if ! out="$(one_engine_tag "${file}" other)"; then
    status=1
    continue
  fi
  tag="${out%% *}"
  if [ "${tag}" != "${COMPOSE_TAG}" ]; then
    echo "FAIL: ${file} pins hatchet-lite:${tag}, ${COMPOSE} pins hatchet-lite:${COMPOSE_TAG} (line ${out##* })" >&2
    status=1
  fi
done

if [ "${status}" -ne 0 ]; then
  echo "An engine upgrade changes the tag in all of these files together (docs/operations/kyu-engine-on-fly.md, Upgrade)." >&2
  exit 1
fi
echo "hatchet-lite:${COMPOSE_TAG} in ${files[*]}"
