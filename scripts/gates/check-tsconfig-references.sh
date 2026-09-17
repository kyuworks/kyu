#!/usr/bin/env bash
# check-tsconfig-references.sh — every workspace package with a tsconfig.json
# is wired into the root tsconfig.json's `references`. `pnpm typecheck` is
# `tsc -b` over those references only, so a package left out is silently
# unchecked by CI's Type Check job.
#
# Env overrides (for tests):
#   ROOT_DIR          — repo root to scan (default: repo root)
#   WORKSPACE_FILE     — path to pnpm-workspace.yaml
#                        (default: <ROOT_DIR>/pnpm-workspace.yaml)
#   ROOT_TSCONFIG      — path to the root tsconfig.json
#                        (default: <ROOT_DIR>/tsconfig.json)
set -euo pipefail
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
WORKSPACE_FILE="${WORKSPACE_FILE:-${ROOT_DIR}/pnpm-workspace.yaml}"
ROOT_TSCONFIG="${ROOT_TSCONFIG:-${ROOT_DIR}/tsconfig.json}"
cd "${ROOT_DIR}"
echo "=== tsconfig references ==="

if [ ! -f "${WORKSPACE_FILE}" ]; then
  echo "FAIL: workspace file not found: ${WORKSPACE_FILE}" >&2
  exit 1
fi
if [ ! -f "${ROOT_TSCONFIG}" ]; then
  echo "FAIL: root tsconfig not found: ${ROOT_TSCONFIG}" >&2
  exit 1
fi

MISSING="$(ROOT_DIR="${ROOT_DIR}" WORKSPACE_FILE="${WORKSPACE_FILE}" ROOT_TSCONFIG="${ROOT_TSCONFIG}" node <<'EOF'
const fs = require("fs");
const path = require("path");

const root = process.env.ROOT_DIR;
const workspaceFile = process.env.WORKSPACE_FILE;
const tsconfigPath = process.env.ROOT_TSCONFIG;

// pnpm-workspace.yaml is a flat list under `packages:`; no other YAML
// feature is in play here, so a tiny line scan beats pulling in a parser.
const lines = fs.readFileSync(workspaceFile, "utf8").split("\n");
const globs = [];
let inPackages = false;
for (const line of lines) {
  if (/^packages:\s*$/.test(line)) {
    inPackages = true;
    continue;
  }
  if (inPackages && /^\S/.test(line)) inPackages = false;
  if (!inPackages) continue;
  const m = line.match(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/);
  if (m) globs.push(m[1]);
}

const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
const refs = new Set((tsconfig.references || []).map((r) => path.normalize(r.path)));

const missing = [];
for (const glob of globs) {
  if (!glob.endsWith("/*")) continue;
  const base = glob.slice(0, -2);
  const baseDir = path.join(root, base);
  if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) continue;
  for (const entry of fs.readdirSync(baseDir).sort()) {
    const dir = path.join(base, entry);
    const absDir = path.join(root, dir);
    if (!fs.statSync(absDir).isDirectory()) continue;
    if (!fs.existsSync(path.join(absDir, "tsconfig.json"))) continue;
    if (!refs.has(path.normalize(dir))) missing.push(dir);
  }
}

process.stdout.write(missing.join("\n"));
EOF
)"

if [ -n "${MISSING}" ]; then
  echo "FAIL: workspace package(s) with a tsconfig.json are missing from ${ROOT_TSCONFIG} references:" >&2
  printf '%s\n' "${MISSING}" | sed 's/^/  - /' >&2
  echo "pnpm typecheck runs tsc -b over the root references only; add the missing path(s)." >&2
  exit 1
fi

echo "OK: every workspace package with a tsconfig.json is referenced from ${ROOT_TSCONFIG}."
