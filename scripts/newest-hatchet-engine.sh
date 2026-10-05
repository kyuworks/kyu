#!/usr/bin/env bash
# newest-hatchet-engine.sh — the newest hatchet-lite release tag in the registry.
# Prints pinned=, newest= and test=yes|no for $GITHUB_OUTPUT (newest-engine.yml).
# test=no when newest is the tag infra/hatchet/compose.yaml pins, unless --force.
# It walks down from the newest release and takes the first tag whose manifest exists;
# a tag with no image (404) is reported on stderr and skipped, any other answer fails.
#
# Env (tests): NEWEST_ENGINE_COMPOSE; NEWEST_ENGINE_TAGS, a file of tags one per line
# (unset: ask ghcr.io anonymously, every page); NEWEST_ENGINE_MANIFESTS, only read when
# NEWEST_ENGINE_TAGS is set, lines "<tag> <http status>" (a tag not listed has status 200).
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
MANIFESTS_FILE="${NEWEST_ENGINE_MANIFESTS:-}"
export COMPOSE TAGS_FILE MANIFESTS_FILE FORCE

node --input-type=module <<'EOF'
import { readFileSync } from 'node:fs'
const { COMPOSE, TAGS_FILE, MANIFESTS_FILE, FORCE } = process.env
const IMAGE = 'hatchet-dev/hatchet/hatchet-lite'
const MAX_PAGES = 50
const MAX_CANDIDATES = 20
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')
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

async function ghcr(what, path, token) {
  const headers = token ? { authorization: `Bearer ${token}`, accept: ACCEPT } : {}
  try {
    return await fetch(`https://ghcr.io${path}`, { headers })
  } catch (error) {
    return fail(`${what}: ${error.message}`)
  }
}
async function ghcrJson(what, res) {
  if (!res.ok) fail(`${what}: HTTP ${res.status}`)
  try {
    return await res.json()
  } catch {
    return fail(`${what} is not JSON`)
  }
}

async function pullToken() {
  const what = 'ghcr.io pull token'
  const body = await ghcrJson(what, await ghcr(what, `/token?scope=repository:${IMAGE}:pull`))
  return body?.token || fail(`${what} answer holds no token`)
}

async function registryTags(token) {
  const tags = []
  let next = `/v2/${IMAGE}/tags/list?n=1000`
  for (let page = 1; next; page += 1) {
    if (page > MAX_PAGES) fail(`the tag list runs past ${MAX_PAGES} pages`)
    const what = `ghcr.io tag list page ${page}`
    const res = await ghcr(what, next, token)
    const body = await ghcrJson(what, res)
    if (!Array.isArray(body?.tags)) fail(`${what} holds no tags array`)
    tags.push(...body.tags)
    const link = res.headers.get('link')
    next = link === null ? '' : NEXT_PAGE.exec(link)?.[1]
    if (next === undefined) fail(`${what} has a Link header this script cannot read`)
  }
  return tags
}

async function manifestStatus(token, tag) {
  if (TAGS_FILE) {
    const lines = MANIFESTS_FILE ? readFileSync(MANIFESTS_FILE, 'utf8').split('\n') : []
    return Number(lines.find((line) => line.startsWith(`${tag} `))?.split(' ')[1] ?? 200)
  }
  const res = await ghcr(`ghcr.io manifest of ${tag}`, `/v2/${IMAGE}/manifests/${tag}`, token)
  await res.body?.cancel()
  return res.status
}

const pins = [...readFileSync(COMPOSE, 'utf8').matchAll(/\/hatchet-lite:\$\{KYU_HATCHET_IMAGE_TAG:-([^}]*)\}/g)].map((m) => m[1])
if (pins.length !== 1) fail(`expected one hatchet-lite default tag in ${COMPOSE}, found ${pins.length}`)
const pinned = pins[0]
if (!RELEASE.test(pinned)) fail(`${COMPOSE} pins ${pinned}, not a vMAJOR.MINOR.PATCH release`)

const token = TAGS_FILE ? '' : await pullToken()
const listed = TAGS_FILE ? readFileSync(TAGS_FILE, 'utf8').split('\n') : await registryTags(token)
const releases = [...new Set(listed.filter((tag) => RELEASE.test(tag)))].sort(compare)
if (releases.length === 0) fail('the registry lists no vMAJOR.MINOR.PATCH tag')
if (!releases.includes(pinned)) fail(`the registry list lacks the pinned ${pinned}, so it may be incomplete`)
const newer = releases.filter((tag) => compare(tag, pinned) > 0).reverse()
let newest = pinned
for (const [i, tag] of newer.entries()) {
  if (i >= MAX_CANDIDATES) fail(`the ${MAX_CANDIDATES} newest release tags have no image`)
  const status = await manifestStatus(token, tag)
  if (status === 200) {
    newest = tag
    break
  }
  if (status !== 404) fail(`ghcr.io manifest of ${tag}: HTTP ${status}`)
  console.error(`${tag} has no image; trying the next release`)
}
const test = newest !== pinned || FORCE === '1' ? 'yes' : 'no'
console.log(`pinned=${pinned}\nnewest=${newest}\ntest=${test}`)
EOF
