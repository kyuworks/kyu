#!/usr/bin/env bash
# check-package-exports.sh — the tarball of every published package under
# packages/ holds each file its manifest points at (`main`, `types`, every
# `exports` target) and every file under its `migrations/` folder.
#
# Packs each package with `pnpm pack`, which runs its `prepack` build first,
# and reads the file list from the tarball itself. Private packages are skipped.
#
# Env (tests): ROOT_DIR
set -euo pipefail
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "${ROOT_DIR}"
echo "=== package exports ==="
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
FAIL=0

for manifest in packages/*/package.json; do
  [ -f "${manifest}" ] || continue
  dir="$(dirname "${manifest}")"
  # An unreadable manifest aborts the gate (set -e); it is never treated as "not private".
  private="$(MANIFEST="${manifest}" node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.env.MANIFEST, "utf8")).private === true))')"
  if [ "${private}" = "true" ]; then
    continue
  fi
  out="${WORK}/$(basename "${dir}")"
  mkdir -p "${out}"
  if ! (cd "${dir}" && pnpm pack --pack-destination "${out}" >"${out}.log" 2>&1); then
    echo "FAIL: ${dir}: pnpm pack failed; log follows" >&2
    cat "${out}.log" >&2
    FAIL=1
    continue
  fi
  tar -tzf "${out}"/*.tgz | sed 's#^package/##' > "${out}.files"
  missing="$(PKG_DIR="${dir}" FILES="${out}.files" node <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.PKG_DIR;
const shipped = new Set(fs.readFileSync(process.env.FILES, "utf8").split("\n").filter(Boolean));
const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
const targets = [];
const walk = (node) => {
  if (typeof node === "string") targets.push(node);
  else if (node && typeof node === "object") Object.values(node).forEach(walk);
};
walk(pkg.exports);
if (pkg.main) targets.push(pkg.main);
if (pkg.types) targets.push(pkg.types);
const missing = [];
for (const target of targets) {
  const rel = path.posix.normalize(target);
  if (rel.includes("*")) missing.push(`${target} (wildcard targets are not checked; list each file)`);
  else if (!shipped.has(rel)) missing.push(`${target} (manifest entry point)`);
}
const migrations = path.join(dir, "migrations");
if (fs.existsSync(migrations)) {
  for (const name of fs.readdirSync(migrations).sort()) {
    if (!shipped.has(`migrations/${name}`)) missing.push(`migrations/${name} (migration file)`);
  }
}
process.stdout.write(missing.join("\n"));
EOF
)"
  if [ -n "${missing}" ]; then
    printf '%s\n' "${missing}" | sed "s#^#FAIL: ${dir} tarball is missing #" >&2
    FAIL=1
  fi
done

if [ "${FAIL}" -ne 0 ]; then
  echo "Build the package, and list the folder in package.json \"files\"." >&2
  exit 1
fi
echo "OK: every package tarball holds its entry points and migrations."
