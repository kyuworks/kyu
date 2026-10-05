// Rules for check-oidc-jobs-skip-cache.sh. Prints "CHECKED <file> <job>" per job
// that can publish and "FAIL: ..." per violation.
//
// A job can publish when its own permissions (else the workflow's) are write-all or
// hold id-token: write. Such a job fails unless its cache-mode (else the workflow's)
// is none, every ./.github/actions/setup step passes cache: false, no step uses
// actions/cache*, and it calls no reusable workflow. A workflow whose strings mention
// the release-age setting needs a top-level cache-mode: none; an action may not.
// A file fails closed on the reading rules in workflow-yaml.mjs.
//
// Usage: node check-oidc-jobs-skip-cache.mjs <workflows dir> <actions dir>
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { isMap, isScalar, isSeq, visit } from 'yaml'
import { isNull, listYamlFiles, readWorkflowYaml, textOf } from './workflow-yaml.mjs'

const LIFTS_RELEASE_AGE = /minimum[-_]?release[-_]?age/i
const CACHE_ACTION = /^actions\/cache(\/[^@]*)?@/i
const SETUP_ACTION = '.github/actions/setup'
const UNREAD = 'cannot read the value of permissions, id-token or cache-mode; write it as a plain string or map'

const out = []
const fail = (msg) => out.push(`FAIL: ${msg}`)

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
  const read = readWorkflowYaml(file, label, fail)
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
  const read = readWorkflowYaml(file, label, fail)
  if (read && liftsReleaseAge(read.doc)) {
    fail(`${label} relaxes the release-age rule; an action cannot set cache-mode: none, so do it in the workflow`)
  }
}

const [workflowsDir, actionsDir] = process.argv.slice(2)
for (const name of listYamlFiles(workflowsDir, fail)) checkWorkflow(path.join(workflowsDir, name))
if (existsSync(actionsDir)) {
  for (const name of readdirSync(actionsDir, { recursive: true }).sort()) {
    const file = path.join(actionsDir, name)
    if (/(^|\/)action\.ya?ml$/.test(name) && statSync(file).isFile()) checkAction(file, actionsDir)
  }
}
process.stdout.write(out.length ? `${out.join('\n')}\n` : '')
