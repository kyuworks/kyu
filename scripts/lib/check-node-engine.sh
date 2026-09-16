#!/usr/bin/env bash
# Fail before any check runs when Node is older than package.json engines.node.
# Env: CHECK_NODE_ENGINE_PACKAGE, CHECK_NODE_ENGINE_VERSION (tests).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export CHECK_NODE_ENGINE_PACKAGE="${CHECK_NODE_ENGINE_PACKAGE:-${ROOT_DIR}/package.json}"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node is not on PATH" >&2
  exit 2
fi

if [ ! -f "${CHECK_NODE_ENGINE_PACKAGE}" ]; then
  echo "FAIL: package.json not found: ${CHECK_NODE_ENGINE_PACKAGE}" >&2
  exit 2
fi

node <<'EOF'
const fs = require("fs");

function parseTriple(raw) {
  const match = String(raw)
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function gte(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return true;
    if (left[i] < right[i]) return false;
  }
  return true;
}

const pkgPath = process.env.CHECK_NODE_ENGINE_PACKAGE;
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
} catch (err) {
  const reason = err && err.message ? err.message : String(err);
  process.stderr.write("FAIL: cannot read " + pkgPath + ": " + reason + "\n");
  process.exit(2);
}

const range = pkg && pkg.engines && typeof pkg.engines.node === "string"
  ? pkg.engines.node.trim()
  : "";
if (!range) {
  process.stderr.write("FAIL: package.json has no engines.node\n");
  process.exit(2);
}

const rangeMatch = range.match(/^>=\s*(\d+\.\d+\.\d+)$/);
if (!rangeMatch) {
  process.stderr.write(
    "FAIL: cannot parse package.json engines.node (" + range + ")\n",
  );
  process.exit(2);
}

const rawVersion = process.env.CHECK_NODE_ENGINE_VERSION || process.version;
const current = parseTriple(rawVersion);
const minimum = parseTriple(rangeMatch[1]);
if (!current || !minimum) {
  process.stderr.write("FAIL: cannot parse Node version (" + rawVersion + ")\n");
  process.exit(2);
}

if (!gte(current, minimum)) {
  const display = /^v/i.test(String(rawVersion).trim())
    ? String(rawVersion).trim()
    : "v" + String(rawVersion).trim();
  process.stderr.write(
    "FAIL: Node " + display + " does not satisfy package.json engines.node (" + range + ").\n",
  );
  process.exit(1);
}
EOF
