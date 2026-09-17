#!/usr/bin/env bash
# check-package-boundaries.sh — a workspace package reaches another only through
# its package name, never through a relative path or a deep dist/src import.
#
# Blocked in packages/*/src and examples/*/src:
#   from '../../<other-package>/...'     relative path out of the package
#   from '@kinesin/<pkg>/src/...'        deep import past the exports map
#   from '@kinesin/<pkg>/dist/...'
#
# Blocked in examples/*/src only: examples are the SDK's consumer proof, not
# another package internal to the bus.
#   from '@hatchet-dev/...'              examples consume @kinesin/sdk only
#   from '@kinesin/schemas'              examples consume @kinesin/sdk only
#
# Env (tests): ROOT_DIR
set -euo pipefail
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "${ROOT_DIR}"
echo "=== package boundaries ==="
FAIL=0

check_relative_escapes() {
  local glob="$1" dir
  for pkgdir in ${glob}; do
    dir="${pkgdir%/}"
    [ -d "${dir}/src" ] || continue
    # Relative imports that climb above the package's own directory.
    while IFS= read -r line; do
      [ -n "${line}" ] || continue
      file="${line%%:*}"
      rest="${line#*:}"
      spec="$(printf '%s' "${rest}" | sed -nE "s/.*from ['\"]([^'\"]+)['\"].*/\1/p")"
      [ -n "${spec}" ] || continue
      case "${spec}" in
        ../*)
          target="$(cd "$(dirname "${file}")" && cd "$(dirname "${spec}")" 2>/dev/null && pwd -P || true)"
          [ -n "${target}" ] || continue
          case "${target}" in
            "$(pwd -P)/${dir}"|"$(pwd -P)/${dir}"/*) ;;
            *) echo "FAIL: ${file}: relative import leaves the package: ${spec}" >&2; FAIL=1 ;;
          esac
          ;;
      esac
    done < <(grep -rnE --include='*.ts' --include='*.tsx' --include='*.mts' --exclude-dir=node_modules --exclude-dir=dist "from ['\"]\.\./" "${dir}/src" 2>/dev/null || true)
  done
}

check_deep_imports() {
  local glob="$1"
  local deep
  deep="$(grep -rnE --include='*.ts' --include='*.tsx' --include='*.mts' --exclude-dir=node_modules --exclude-dir=dist "from ['\"]@kinesin/[a-z0-9-]+/(src|dist)/" ${glob}src 2>/dev/null || true)"
  if [ -n "${deep}" ]; then
    printf '%s\n' "${deep}" | sed 's/^/FAIL: deep import past the exports map: /' >&2
    FAIL=1
  fi
}

[ -d packages ] && check_relative_escapes "packages/*/"
[ -d examples ] && check_relative_escapes "examples/*/"
[ -d packages ] && check_deep_imports "packages/*/"
[ -d examples ] && check_deep_imports "examples/*/"

if [ -d examples ]; then
  BANNED="$(grep -rnE --include='*.ts' --include='*.tsx' --include='*.mts' --exclude-dir=node_modules --exclude-dir=dist "from ['\"](@hatchet-dev/|@kinesin/schemas)" examples/*/src 2>/dev/null || true)"
  if [ -n "${BANNED}" ]; then
    printf '%s\n' "${BANNED}" | sed 's/^/FAIL: examples consume @kinesin\/sdk only: /' >&2
    FAIL=1
  fi
fi

if [ "${FAIL}" -ne 0 ]; then
  echo "Import the package by name. Export what you need from its index." >&2
  exit 1
fi
echo "OK: package boundaries hold."
