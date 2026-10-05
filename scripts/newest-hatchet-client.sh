#!/usr/bin/env bash
# newest-hatchet-client.sh — the newest stable Hatchet client inside packages/sdk's range.
# Prints range=, lockfile=, newest= and test=yes|no for $GITHUB_OUTPUT (newest-client.yml).
# test=no when newest is the lockfile's version, unless --force.
#
# Env (tests): NEWEST_CLIENT_SDK_PACKAGE, NEWEST_CLIENT_LOCKFILE, and
# NEWEST_CLIENT_VERSIONS (a file holding `npm view <pkg> versions --json`; unset asks the registry).
#
# Self-test: bash scripts/newest-hatchet-client.test.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORCE=0
for arg in "$@"; do
  case "${arg}" in
    --force) FORCE=1 ;;
    *)
      echo "FAIL: unknown argument: ${arg}" >&2
      echo "Usage: $0 [--force]" >&2
      exit 2
      ;;
  esac
done

SDK_PACKAGE="${NEWEST_CLIENT_SDK_PACKAGE:-${ROOT_DIR}/packages/sdk/package.json}"
LOCKFILE="${NEWEST_CLIENT_LOCKFILE:-${ROOT_DIR}/pnpm-lock.yaml}"
VERSIONS_FILE="${NEWEST_CLIENT_VERSIONS:-}"
if [ -z "${VERSIONS_FILE}" ]; then
  VERSIONS_FILE="$(mktemp)"
  trap 'rm -f "${VERSIONS_FILE}"' EXIT
  npm view @hatchet-dev/typescript-sdk versions --json > "${VERSIONS_FILE}"
fi
export SDK_PACKAGE LOCKFILE VERSIONS_FILE FORCE

node <<'EOF'
const fs = require('node:fs')
const { SDK_PACKAGE, LOCKFILE, VERSIONS_FILE, FORCE } = process.env
const NAME = '@hatchet-dev/typescript-sdk'
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}
const triple = (v) => STABLE.exec(v).slice(1, 4).map(Number)
function compare(a, b) {
  const [x, y] = [triple(a), triple(b)]
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

const range = JSON.parse(fs.readFileSync(SDK_PACKAGE, 'utf8')).dependencies?.[NAME]
if (!range) fail(`${SDK_PACKAGE} does not depend on ${NAME}`)
// A caret on a 1.x or later version admits every later minor and patch of that major.
const caret = /^\^([1-9]\d*\.\d+\.\d+)$/.exec(range)
if (!caret) fail(`unsupported range ${range}: only ^MAJOR.MINOR.PATCH with MAJOR 1 or more`)
const floor = caret[1]

// The packages: section keys each resolved version once; snapshot keys carry "(peer...)".
const locked = [...fs.readFileSync(LOCKFILE, 'utf8').matchAll(/^  '@hatchet-dev\/typescript-sdk@([^'(]+)':$/gm)].map((m) => m[1])
if (locked.length !== 1) fail(`expected one ${NAME} version in ${LOCKFILE}, found ${locked.length}`)

const listed = JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf8'))
const inRange = [listed]
  .flat()
  .filter((v) => STABLE.test(v) && triple(v)[0] === triple(floor)[0] && compare(v, floor) >= 0)
  .sort(compare)
if (inRange.length === 0) fail(`no stable ${NAME} version satisfies ${range}`)
const newest = inRange[inRange.length - 1]
const test = newest !== locked[0] || FORCE === '1' ? 'yes' : 'no'
console.log(`range=${range}\nlockfile=${locked[0]}\nnewest=${newest}\ntest=${test}`)
EOF
