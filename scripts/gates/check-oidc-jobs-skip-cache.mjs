// Rules for check-oidc-jobs-skip-cache.sh. Prints "CHECKED <file> <job>" per job
// that can publish and "FAIL: ..." per violation.
//
// A job can publish when its own permissions (else the workflow's) are write-all or
// hold id-token: write. Such a job fails unless its cache-mode (else the workflow's)
// is none, every ./.github/actions/setup step passes cache: false, no step uses
// actions/cache*, and it calls no reusable workflow. A workflow whose strings mention
// the release-age setting needs a top-level cache-mode: none; an action may not.
// A file fails closed where this reader and GitHub's could differ: a parse error,
// not one document, a duplicate key (any letter case), a key that is not a string,
// a merge key, a tag, a %YAML or %TAG directive, an alias with no anchor or inside
// its own anchor, more aliases than MAX_ALIAS_COUNT, or a value it cannot read.
//
// Usage: node check-oidc-jobs-skip-cache.mjs <workflows dir> <actions dir>
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { LineCounter, Parser, isAlias, isMap, isScalar, isSeq, parseAllDocuments, visit } from 'yaml'

// GitHub reads YAML 1.2 without merge keys; anything the two readers could take differently fails.
const YAML_OPTIONS = { version: '1.2', schema: 'core', merge: false, strict: true, uniqueKeys: true }
const MAX_ALIAS_COUNT = 100
const LIFTS_RELEASE_AGE = /minimum[-_]?release[-_]?age/i
const CACHE_ACTION = /^actions\/cache(\/[^@]*)?@/i
const SETUP_ACTION = '.github/actions/setup'
const UNREAD = 'cannot read the value of permissions, id-token or cache-mode; write it as a plain string or map'

const isNull = (node) => node === undefined || (isScalar(node) && node.value === null)
const textOf = (node) => (isScalar(node) && typeof node.value === 'string' ? node.value : undefined)

const out = []
const fail = (msg) => out.push(`FAIL: ${msg}`)

// Returns the document and a line lookup, or null after printing why the file cannot be trusted.
function readWorkflowYaml(file, label) {
  const lines = new LineCounter()
  const text = readFileSync(file, 'utf8')
  const docs = parseAllDocuments(text, { ...YAML_OPTIONS, lineCounter: lines })
  if (!Array.isArray(docs) || docs.length === 0) return fail(`${label} holds no YAML document`), null
  if (docs.length > 1) return fail(`${label} holds ${docs.length} YAML documents; GitHub reads one, so keep one`), null
  const [doc] = docs
  const lineOf = (node) => lines.linePos(node?.range?.[0] ?? 0).line
  const [problem] = [...doc.errors, ...doc.warnings]
  if (problem) return fail(`${label} line ${problem.linePos?.[0]?.line ?? 1} does not parse: ${problem.message.split(' at line ')[0]}`), null
  const tagDirective = [...new Parser().parse(text)].some((token) => token.type === 'directive' && token.source.startsWith('%TAG'))
  if (doc.directives.yaml.explicit || tagDirective) {
    return fail(`${label} uses a %YAML or %TAG directive; the gate reads YAML 1.2 only, so remove it`), null
  }
  const before = out.length
  const anchors = new Set()
  visit(doc, {
    Alias(_, node, ancestors) {
      if (!anchors.has(node.source)) fail(`${label} line ${lineOf(node)} uses alias *${node.source} with no anchor before it`)
      if (ancestors.some((up) => up.anchor === node.source)) fail(`${label} line ${lineOf(node)} uses alias *${node.source} inside its own anchor`)
    },
    Node(_, node) {
      if (node.tag) fail(`${label} line ${lineOf(node)} has a YAML tag (${node.tag}); write the value without it`)
      if (node.anchor) anchors.add(node.anchor)
      const seen = new Set()
      for (const { key } of isMap(node) ? node.items : []) {
        const folded = textOf(key)?.toLowerCase()
        if (folded !== undefined && seen.has(folded)) fail(`${label} line ${lineOf(key)} repeats a key in another letter case`)
        seen.add(folded)
      }
    },
    Pair(_, pair) {
      const key = pair.key
      if (textOf(key) === undefined) {
        fail(`${label} line ${lineOf(key)} has a key that is not a plain string; write it as text`)
      } else if (key.value === '<<') {
        fail(`${label} line ${lineOf(key)} uses a YAML merge key; GitHub does not support merge keys, so write it out`)
      }
    },
  })
  if (out.length > before) return null
  try {
    doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT, mapAsMap: true })
  } catch (e) {
    return fail(`${label} cannot resolve its YAML aliases: ${e.message}`), null
  }
  if (!isMap(doc.contents)) return fail(`${label} line ${lineOf(doc.contents)} is not a YAML map at the top level`), null
  const deref = (node) => (isAlias(node) ? node.resolve(doc) : node)
  // Keys match in any letter case: GitHub's own matching is not documented.
  const field = (map, name) => deref(map.items.find((pair) => pair.key.value.toLowerCase() === name)?.value)
  return { doc, lineOf, field, deref }
}

function liftsReleaseAge(doc) {
  let lifts = false
  visit(doc, {
    Scalar(_, node) {
      if (typeof node.value === 'string' && LIFTS_RELEASE_AGE.test(node.value)) lifts = true
    },
  })
  return lifts
}

// A grant the gate cannot read counts as one, so the job is still checked.
function grantsIdToken(node, where, read) {
  if (isNull(node)) return false
  const shorthand = textOf(node)
  if (shorthand === 'write-all') return true
  if (shorthand === 'read-all') return false
  if (isMap(node)) {
    const level = read.field(node, 'id-token')
    if (isNull(level)) return false
    if (textOf(level) === 'write') return true
    if (textOf(level) === 'read' || textOf(level) === 'none') return false
    return fail(`${where} line ${read.lineOf(level)} ${UNREAD}`), true
  }
  return fail(`${where} line ${read.lineOf(node)} ${UNREAD}`), true
}

function checkPublishingJob(label, name, job, top, read) {
  const { field, lineOf } = read
  out.push(`CHECKED ${label} ${name}`)
  const jobMode = field(job, 'cache-mode')
  const mode = jobMode === undefined ? field(top, 'cache-mode') : jobMode
  if (textOf(mode) !== 'none') fail(`${label} job ${name} has id-token: write but does not set cache-mode: none`)
  if (field(job, 'uses') !== undefined) {
    fail(`${label} job ${name} has id-token: write and calls a reusable workflow; the gate cannot see its steps`)
  }
  const steps = field(job, 'steps')
  if (isNull(steps)) return
  if (!isSeq(steps)) return fail(`${label} line ${lineOf(steps)} cannot read the steps of job ${name}`)
  let setupBad = false
  let direct = false
  for (const item of steps.items) {
    const step = read.deref(item)
    if (!isMap(step)) {
      fail(`${label} line ${lineOf(step)} cannot read a step of job ${name}`)
      continue
    }
    const uses = field(step, 'uses')
    if (uses === undefined) continue
    const ref = textOf(uses)
    if (ref === undefined) {
      fail(`${label} line ${lineOf(uses)} cannot read a step of job ${name}`)
      continue
    }
    if (CACHE_ACTION.test(ref)) direct = true
    if (ref.startsWith('./') && path.posix.normalize(ref).replace(/\/$/, '') === SETUP_ACTION) {
      const inputs = field(step, 'with')
      if (!isNull(inputs) && !isMap(inputs)) fail(`${label} line ${lineOf(inputs)} cannot read the inputs of a step of job ${name}`)
      const cache = isMap(inputs) ? field(inputs, 'cache') : undefined
      if (!(isScalar(cache) && cache.source === 'false')) setupBad = true
    }
  }
  if (setupBad) fail(`${label} job ${name} uses ./.github/actions/setup without cache: 'false'`)
  if (direct) fail(`${label} job ${name} uses actions/cache directly`)
}

function checkWorkflow(file) {
  const label = path.basename(file)
  const read = readWorkflowYaml(file, label)
  if (!read) return
  const top = read.doc.contents
  const { field, lineOf } = read
  if (liftsReleaseAge(read.doc) && textOf(field(top, 'cache-mode')) !== 'none') {
    fail(`${label} mentions minimumReleaseAge but does not set top-level cache-mode: none`)
  }
  const workflowGrant = grantsIdToken(field(top, 'permissions'), label, read)
  const jobs = field(top, 'jobs')
  if (isNull(jobs)) return
  if (!isMap(jobs)) return fail(`${label} line ${lineOf(jobs)} cannot read jobs`)
  for (const pair of jobs.items) {
    const name = pair.key.value
    const job = read.deref(pair.value)
    if (!isMap(job)) {
      fail(`${label} line ${lineOf(job)} cannot read job ${name}`)
      continue
    }
    const own = field(job, 'permissions')
    const publishes = isNull(own) ? workflowGrant : grantsIdToken(own, label, read)
    if (publishes) checkPublishingJob(label, name, job, top, read)
  }
}

function checkAction(file, actionsDir) {
  const label = path.relative(path.dirname(actionsDir), file)
  const read = readWorkflowYaml(file, label)
  if (read && liftsReleaseAge(read.doc)) {
    fail(`${label} relaxes the release-age rule; an action cannot set cache-mode: none, so do it in the workflow`)
  }
}

const [workflowsDir, actionsDir] = process.argv.slice(2)
const isFile = (file) => statSync(file).isFile()
for (const name of readdirSync(workflowsDir).sort()) {
  const file = path.join(workflowsDir, name)
  if (!/\.ya?ml$/i.test(name) || !isFile(file)) continue
  if (/\.ya?ml$/.test(name)) checkWorkflow(file)
  else fail(`${name} has a workflow extension in another letter case; GitHub's reading of it is not documented, so rename it to .yml`)
}
if (existsSync(actionsDir)) {
  for (const name of readdirSync(actionsDir, { recursive: true }).sort()) {
    const file = path.join(actionsDir, name)
    if (/(^|\/)action\.ya?ml$/.test(name) && isFile(file)) checkAction(file, actionsDir)
  }
}
process.stdout.write(out.length ? `${out.join('\n')}\n` : '')
