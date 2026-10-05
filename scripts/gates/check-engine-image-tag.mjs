// Rules for check-engine-image-tag.sh. Exits 1 after printing each FAIL line.
//
// compose.yaml, and every *.yml and *.yaml under .github/, is read with workflow-yaml.mjs, so
// a file it cannot read fails. Every string value or key that names /hatchet-lite, in any
// layout and after YAML escapes and line folding, is a reference. A reference's tag must equal
// the compose default, and a file may not name two tags. A digest after a tag, hatchet-lite with
// no / before it, or in upper case, fails in any YAML string. fly.toml is not YAML: outside
// comments it names the engine, image or build only in [build] and the one line after it,
// image = '<registry>/hatchet-lite:<tag>', and holds no escape or multi-line string. In compose.yaml
// every reference must be an image: value written hatchet-lite:${KYU_HATCHET_IMAGE_TAG:-<tag>}.
// One exemption: newest-engine.yml may name the tag its pick job chose at run time, written
// exactly hatchet-lite:${{ needs.pick.outputs.tag }}; that reference is not compared.
//
// Usage: node check-engine-image-tag.mjs <repo root>
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { visit } from 'yaml'
import { listYamlFiles, readWorkflowYaml, textOf } from './workflow-yaml.mjs'

const COMPOSE = 'infra/hatchet/compose.yaml'
const FLY = 'infra/hatchet/fly/fly.toml'
const REQUIRED_WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/newest-client.yml']
const ENGINE = '/hatchet-lite'
const COMPOSE_IMAGE = /^\S*\/hatchet-lite:\$\{KYU_HATCHET_IMAGE_TAG:-([^}]*)\}$/
const RELEASE = /^v\d+\.\d+\.\d+$/
const UNREAD = '(unreadable)'
const RUNTIME = '(run-time)'
const RUNTIME_FILE = '.github/workflows/newest-engine.yml'
const RUNTIME_TAG = '${{ needs.pick.outputs.tag }}'
const AFTER_TAG = ' \t\r\n"\'@,]}#'
const AFTER_RUNTIME = ' \t\r\n"\',]}#'
const SPELLED = /hatchet-lite(?=:\S|@)/gi
const DIGEST = /^(:[^\s"'@,\]}#]*)?@/
const FLY_BUILD = /^\s*\[build\]\s*$/
const FLY_IMAGE = /^\s*image\s*=\s*(['"])[^\s'"\\@]*\/hatchet-lite:[^\s'"\\@]+\1\s*$/
const FLY_WATCHED = /\bbuild\b|\bimage\b|hatchet-lite|'''|"""|\\/i

const root = process.argv[2]
const failures = []
const fail = (msg) => failures.push(`FAIL: ${msg}`)
const isFile = (file) => existsSync(path.join(root, file)) && statSync(path.join(root, file)).isFile()

// The tag of each engine reference in one string: (none) when untagged, (unreadable) when
// anything but a delimiter follows the tag. (run-time) only when runtime is set and the text is
// exactly RUNTIME_TAG.
function referenceTags(text, runtime = false) {
  const tags = []
  for (let at = text.indexOf(ENGINE); at >= 0; at = text.indexOf(ENGINE, at + 1)) {
    const rest = text.slice(at + ENGINE.length)
    const after = rest[1 + RUNTIME_TAG.length]
    if (runtime && rest.startsWith(`:${RUNTIME_TAG}`) && (after === undefined || AFTER_RUNTIME.includes(after))) {
      tags.push(RUNTIME)
      continue
    }
    const tag = /^:([A-Za-z0-9._-]+)/.exec(rest)
    if (tag) tags.push(rest.length === tag[0].length || AFTER_TAG.includes(rest[tag[0].length]) ? tag[1] : UNREAD)
    else tags.push(/^[:A-Za-z0-9_.-]/.test(rest) ? UNREAD : '(none)')
  }
  return tags
}

// Why each image-like hatchet-lite in one string cannot be compared: Docker pulls by a digest,
// and a bare or upper-case name is not the engine reference the other rules read.
function engineSpelling(text) {
  const found = []
  for (const { 0: name, index } of text.matchAll(SPELLED)) {
    if (name !== 'hatchet-lite') found.push('names hatchet-lite in upper case')
    else if (text[index - 1] !== '/') found.push('names hatchet-lite with no / before it; write the registry path')
    else if (DIGEST.test(text.slice(index + name.length))) found.push('names hatchet-lite with a digest; pin the tag alone')
  }
  return found
}

// [{ tag, line }] for one YAML file, or null when the reader failed it.
function yamlReferences(file) {
  const read = readWorkflowYaml(path.join(root, file), file, fail)
  if (!read) return null
  const refs = []
  visit(read.doc, {
    Scalar(key, node, ancestors) {
      if (textOf(node) === undefined) return
      for (const problem of engineSpelling(node.value)) fail(`${file}:${read.lineAt(node.range[0])} ${problem}`)
      const raw = read.source.slice(node.range[0], node.range[1])
      let from = 0
      for (let tag of referenceTags(node.value, file === RUNTIME_FILE)) {
        // An escaped reference is not in the raw text; it is reported on the value's first line.
        const at = raw.indexOf(ENGINE, from)
        from = at < 0 ? from : at + 1
        if (file === COMPOSE) {
          const owner = ancestors.at(-1)
          const image = key === 'value' && textOf(owner.key) === 'image' ? COMPOSE_IMAGE.exec(node.value) : null
          tag = image ? image[1] : UNREAD
        }
        refs.push({ tag, line: read.lineAt(node.range[0] + Math.max(at, 0)) })
      }
    },
  })
  return refs
}

// The [build] image line's reference, or null after failing each line outside that layout.
function flyReferences(file) {
  const code = readFileSync(path.join(root, file), 'utf8')
    .split('\n')
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => !/^\s*(#|$)/.test(text))
  const build = code.findIndex(({ text }) => FLY_BUILD.test(text))
  const image = build < 0 ? undefined : code[build + 1]
  const laidOut = image !== undefined && FLY_IMAGE.test(image.text) && (code[build + 2]?.text.trim().startsWith('[') ?? true)
  const stray = code.filter(({ text }, i) => !(i === build || (laidOut && i === build + 1)) && FLY_WATCHED.test(text))
  for (const { line } of stray) fail(`${file}:${line} names build, image or hatchet-lite, or holds an escape or multi-line string`)
  if (laidOut && stray.length === 0) return referenceTags(image.text).map((tag) => ({ tag, line: image.line }))
  return fail(`${file} must set the engine on the line after [build], as image = '<registry>/hatchet-lite:<tag>', and nowhere else`), null
}

// { tag, line of the first reference } when every reference reads to one tag; else null after failing.
function oneEngineTag(file, refs) {
  if (refs === null) return null
  if (refs.length === 0) return fail(`no hatchet-lite image tag found in ${file}`), null
  const unread = refs.filter((ref) => ref.tag === UNREAD)
  for (const { line } of unread) fail(`${file}:${line} names hatchet-lite in a layout this gate cannot read`)
  if (unread.length) return null
  const named = refs.filter((ref) => ref.tag !== RUNTIME)
  const firstLine = new Map()
  for (const { tag, line } of named) if (!firstLine.has(tag)) firstLine.set(tag, line)
  if (firstLine.size > 1) {
    const each = [...firstLine].sort(([a], [b]) => (a < b ? -1 : 1)).map(([tag, line]) => `${tag} (line ${line})`)
    return fail(`${file} pins more than one hatchet-lite tag: ${each.join(', ')}`), null
  }
  return named[0] ?? refs[0]
}

function finish(note) {
  process.stderr.write(`${[...failures, note].join('\n')}\n`)
  process.exit(1)
}

function referencesIn(file) {
  if (!isFile(file)) return fail(`${file} not found`), null
  return file === FLY ? flyReferences(file) : yamlReferences(file)
}

const references = new Map([[COMPOSE, referencesIn(COMPOSE)]])
const compose = oneEngineTag(COMPOSE, references.get(COMPOSE))
if (!compose) finish(`${COMPOSE} must name the engine only as hatchet-lite:\${KYU_HATCHET_IMAGE_TAG:-<tag>}.`)
if (!RELEASE.test(compose.tag)) finish(`FAIL: ${COMPOSE} pins hatchet-lite:${compose.tag}, not a vMAJOR.MINOR.PATCH release`)
for (const file of [FLY, ...REQUIRED_WORKFLOWS]) references.set(file, referencesIn(file))

if (existsSync(path.join(root, '.github'))) {
  for (const name of listYamlFiles(path.join(root, '.github'), fail, { recursive: true })) {
    const file = path.posix.join('.github', name)
    if (references.has(file)) continue
    const refs = yamlReferences(file)
    if (refs?.length) references.set(file, refs)
  }
}

for (const [file, refs] of [...references].slice(1)) {
  const one = oneEngineTag(file, refs)
  if (one && one.tag !== RUNTIME && one.tag !== compose.tag) {
    fail(`${file} pins hatchet-lite:${one.tag}, ${COMPOSE} pins hatchet-lite:${compose.tag} (line ${one.line})`)
  }
}
if (failures.length) finish('An engine upgrade changes the tag in all of these files together (docs/operations/kyu-engine-on-fly.md, Upgrade).')
process.stdout.write(`hatchet-lite:${compose.tag} in ${[...references.keys()].join(' ')}\n`)
