#!/usr/bin/env bash
# check-package-versions.sh — the published packages under packages/ release
# in lockstep: one version in every manifest and in the SDK's SDK_VERSION,
# and a dependency on a sibling written as `workspace:*`, which `pnpm publish`
# rewrites to that exact version. With RELEASE_TAG set (the release workflow),
# the tag must be `v<version>`.
#
# Env (tests): ROOT_DIR, RELEASE_TAG
set -euo pipefail
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "${ROOT_DIR}"
echo "=== package versions ==="

# A file, not $(...): bash misparses quotes in a heredoc inside command substitution.
PROBLEMS_FILE="$(mktemp)"
trap 'rm -f "${PROBLEMS_FILE}"' EXIT
RELEASE_TAG="${RELEASE_TAG:-}" node > "${PROBLEMS_FILE}" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const pkgs = fs.readdirSync("packages").sort()
  .map((dir) => path.join("packages", dir, "package.json"))
  .filter((file) => fs.existsSync(file))
  .map((file) => ({ file, json: JSON.parse(fs.readFileSync(file, "utf8")) }))
  .filter((p) => p.json.private !== true);
const problems = [];
const versions = new Set(pkgs.map((p) => p.json.version));
const names = new Set(pkgs.map((p) => p.json.name));
if (versions.size !== 1) {
  problems.push(`versions differ: ${pkgs.map((p) => `${p.file}=${p.json.version}`).join(", ")}`);
}
const [version] = versions;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) problems.push(`not a semver version: ${version}`);
for (const p of pkgs) {
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(p.json[field] ?? {})) {
      if (names.has(name) && range !== "workspace:*") problems.push(`${p.file}: ${field}.${name} is "${range}", expected "workspace:*"`);
    }
  }
}
const versionFile = path.join("packages", "sdk", "src", "version.ts");
if (fs.existsSync(versionFile)) {
  const m = fs.readFileSync(versionFile, "utf8").match(/SDK_VERSION = '([^']*)'/);
  if (!m) problems.push(`${versionFile}: no SDK_VERSION = '<version>' line`);
  else if (m[1] !== version) problems.push(`${versionFile}: SDK_VERSION is ${m[1]}, manifests say ${version}`);
}
const tag = process.env.RELEASE_TAG;
if (tag && tag !== `v${version}`) problems.push(`tag ${tag} does not match the manifests' version v${version}`);
process.stdout.write(problems.join("\n"));
EOF
PROBLEMS="$(cat "${PROBLEMS_FILE}")"

if [ -n "${PROBLEMS}" ]; then
  printf '%s\n' "${PROBLEMS}" | sed 's/^/FAIL: /' >&2
  echo "Bump every packages/*/package.json and packages/sdk/src/version.ts together in one PR." >&2
  exit 1
fi
echo "OK: published packages share one version."
