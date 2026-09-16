#!/usr/bin/env bash
# check-package-boundaries.sh — a workspace package reaches another only through
# its package name, never through a relative path or a deep dist/src import.
#
# Blocked in packages/*/src:
#   from '../../<other-package>/...'     relative path out of the package
#   from '@kinesin/<pkg>/src/...'        deep import past the exports map
#   from '@kinesin/<pkg>/dist/...'
#
# Env (tests): ROOT_DIR
set -euo pipefail
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "${ROOT_DIR}"
echo "=== package boundaries ==="
[ -d packages ] || { echo "OK: no packages directory."; exit 0; }
FAIL=0
for pkgdir in packages/*/; do
  pkg="${pkgdir%/}"
  [ -d "${pkg}/src" ] || continue
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
          "$(pwd -P)/${pkg}"|"$(pwd -P)/${pkg}"/*) ;;
          *) echo "FAIL: ${file}: relative import leaves the package: ${spec}" >&2; FAIL=1 ;;
        esac
        ;;
    esac
  done < <(grep -rnE --include='*.ts' --include='*.tsx' --include='*.mts' --exclude-dir=node_modules --exclude-dir=dist "from ['\"]\.\./" "${pkg}/src" 2>/dev/null || true)
done
DEEP="$(grep -rnE --include='*.ts' --include='*.tsx' --include='*.mts' --exclude-dir=node_modules --exclude-dir=dist "from ['\"]@kinesin/[a-z0-9-]+/(src|dist)/" packages/*/src 2>/dev/null || true)"
if [ -n "${DEEP}" ]; then
  printf '%s\n' "${DEEP}" | sed 's/^/FAIL: deep import past the exports map: /' >&2
  FAIL=1
fi
if [ "${FAIL}" -ne 0 ]; then
  echo "Import the package by name. Export what you need from its index." >&2
  exit 1
fi
echo "OK: package boundaries hold."
