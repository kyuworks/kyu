#!/usr/bin/env bash
# newest-hatchet-engine.sh — the newest hatchet-lite release tag in the registry.
# Prints pinned=, newest= and test=yes|no for $GITHUB_OUTPUT (newest-engine.yml).
# test=no when newest is the tag infra/hatchet/compose.yaml pins, unless --force.
#
# Env (tests): NEWEST_ENGINE_COMPOSE, and NEWEST_ENGINE_TAGS (a file of tags, one per
# line; unset asks ghcr.io anonymously, every page).
#
# Self-test: bash scripts/newest-hatchet-engine.test.sh
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

COMPOSE="${NEWEST_ENGINE_COMPOSE:-${ROOT_DIR}/infra/hatchet/compose.yaml}"
TAGS_FILE="${NEWEST_ENGINE_TAGS:-}"
export COMPOSE TAGS_FILE FORCE

node --input-type=module <<'EOF'
import { readFileSync } from 'node:fs'
const { COMPOSE, TAGS_FILE, FORCE } = process.env
const IMAGE = 'hatchet-dev/hatchet/hatchet-lite'
const MAX_PAGES = 50
// No leading zeros; the anchors keep a hostile tag out of $GITHUB_OUTPUT.
const RELEASE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
// Only a same-host /v2/ path: the token is never sent anywhere else.
const NEXT_PAGE = /^<(\/v2\/[^>]+)>;\s*rel="next"$/

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}
const triple = (tag) => RELEASE.exec(tag).slice(1, 4).map(Number)
function compare(a, b) {
  const [x, y] = [triple(a), triple(b)]
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

async function registryTags() {
  const auth = await fetch(`https://ghcr.io/token?scope=repository:${IMAGE}:pull`)
  if (!auth.ok) fail(`ghcr.io refused an anonymous pull token: HTTP ${auth.status}`)
  const { token } = await auth.json()
  if (!token) fail('ghcr.io answered without a pull token')
  const tags = []
  let next = `/v2/${IMAGE}/tags/list?n=1000`
  for (let page = 1; next; page += 1) {
    if (page > MAX_PAGES) fail(`the tag list runs past ${MAX_PAGES} pages`)
    const res = await fetch(`https://ghcr.io${next}`, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) fail(`ghcr.io tag list page ${page}: HTTP ${res.status}`)
    const body = await res.json()
    if (!Array.isArray(body.tags)) fail(`ghcr.io tag list page ${page} holds no tags array`)
    tags.push(...body.tags)
    const link = res.headers.get('link')
    next = link === null ? '' : NEXT_PAGE.exec(link)?.[1]
    if (next === undefined) fail(`ghcr.io tag list page ${page} has a Link header this script cannot read`)
  }
  return tags
}

const pins = [...readFileSync(COMPOSE, 'utf8').matchAll(/\/hatchet-lite:\$\{KYU_HATCHET_IMAGE_TAG:-([^}]*)\}/g)].map((m) => m[1])
if (pins.length !== 1) fail(`expected one hatchet-lite default tag in ${COMPOSE}, found ${pins.length}`)
const pinned = pins[0]
if (!RELEASE.test(pinned)) fail(`${COMPOSE} pins ${pinned}, not a vMAJOR.MINOR.PATCH release`)

const listed = TAGS_FILE ? readFileSync(TAGS_FILE, 'utf8').split('\n') : await registryTags()
const releases = listed.filter((tag) => RELEASE.test(tag)).sort(compare)
if (releases.length === 0) fail('the registry lists no vMAJOR.MINOR.PATCH tag')
if (!releases.includes(pinned)) fail(`the registry list lacks the pinned ${pinned}, so it may be incomplete`)
const newest = releases[releases.length - 1]
const test = newest !== pinned || FORCE === '1' ? 'yes' : 'no'
console.log(`pinned=${pinned}\nnewest=${newest}\ntest=${test}`)
EOF
