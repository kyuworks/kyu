// Rules for check-required-ci-jobs.sh. Exits 1 after printing each FAIL line.
//
// A workflow runs on pull_request when on: is pull_request, a list that holds it, or a map
// with that key; pull_request_target does not count. A job's check name is its name:, else
// its job id. A job with a matrix, one that calls a reusable workflow, or a name: that holds ${{
// counts for no name: GitHub builds its check names at run time. Every workflow file is read with
// workflow-yaml.mjs, so a file it cannot read fails, pull-request workflow or not.
//
// A required name must be the check name of exactly one job across every workflow; that count
// covers literal names only, so a job whose name: is an expression or that has a matrix is not
// counted. That job may not have if: or needs: (GitHub reports a skipped job as passing), nor
// continue-on-error: on the job (the run passes when the job fails) or on any step (the job passes
// when the step fails). Its workflow's pull_request trigger may hold only types:, which must
// include opened, synchronize and reopened (a workflow that does not run leaves the check pending).
//
// Usage: node check-required-ci-jobs.mjs <workflows dir> <required-checks file>
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isMap, isSeq } from 'yaml'
import { isNull, listYamlFiles, readWorkflowYaml, textOf } from './workflow-yaml.mjs'

const PULL_REQUEST = 'pull_request'
const SKIPPING_KEYS = ['if', 'needs', 'continue-on-error']
const DEFAULT_TYPES = ['opened', 'synchronize', 'reopened']
const [workflowsDir, requiredFile] = process.argv.slice(2)
const failures = []
const fail = (msg) => failures.push(`FAIL: ${msg}`)

function runsOnPullRequest(on, read) {
  if (textOf(on) === PULL_REQUEST) return true
  if (isSeq(on)) return on.items.some((item) => textOf(read.deref(item)) === PULL_REQUEST)
  return isMap(on) && on.items.some((pair) => pair.key.value === PULL_REQUEST)
}

// [{ name, id, job, line }] for each job that has a check name GitHub reports as written.
function namedJobs(label, jobs, read) {
  const named = []
  for (const pair of jobs.items) {
    const id = pair.key.value
    const job = read.deref(pair.value)
    if (!isMap(job)) {
      fail(`${label} line ${read.lineOf(job)} cannot read job ${id}`)
      continue
    }
    const strategy = read.field(job, 'strategy')
    const matrix = isMap(strategy) ? read.field(strategy, 'matrix') : strategy
    if (read.field(job, 'uses') !== undefined || !isNull(matrix)) continue
    const name = read.field(job, 'name')
    if (textOf(name)?.includes('${{')) continue
    const line = read.lineOf(pair.key)
    if (isNull(name)) named.push({ name: id, id, job, line })
    else if (textOf(name) !== undefined) named.push({ name: textOf(name), id, job, line })
    else fail(`${label} line ${read.lineOf(name)} cannot read the name of job ${id}; write it as plain text`)
  }
  return named
}

// Why the pull_request trigger can leave a run out: each filter key, or types: without a default.
function triggerFilters(on, read) {
  const trigger = isMap(on) ? read.field(on, PULL_REQUEST) : undefined
  if (isNull(trigger)) return []
  if (!isMap(trigger)) return [`a value it cannot read (line ${read.lineOf(trigger)})`]
  const found = []
  for (const pair of trigger.items) {
    const key = pair.key.value
    if (key.toLowerCase() !== 'types') {
      found.push(`${key}: (line ${read.lineOf(pair.key)})`)
      continue
    }
    const value = read.deref(pair.value)
    const types = isSeq(value) ? value.items.map((item) => textOf(read.deref(item))) : [textOf(value)]
    const lacking = DEFAULT_TYPES.filter((type) => !types.includes(type))
    if (lacking.length) found.push(`types: without ${lacking.join(', ')} (line ${read.lineOf(pair.key)})`)
  }
  return found
}

const prWorkflows = []
const suppliers = []
for (const name of listYamlFiles(workflowsDir, fail)) {
  const file = path.join(workflowsDir, name)
  const read = readWorkflowYaml(file, name, fail)
  if (!read) continue
  const on = read.field(read.doc.contents, 'on')
  const pr = runsOnPullRequest(on, read)
  if (pr) prWorkflows.push(file)
  const jobs = read.field(read.doc.contents, 'jobs')
  if (isMap(jobs)) for (const job of namedJobs(name, jobs, read)) suppliers.push({ ...job, label: name, read, on, pr })
  else if (!isNull(jobs)) fail(`${name} line ${read.lineOf(jobs)} cannot read jobs`)
}
const jobNames = new Set(suppliers.filter((job) => job.pr).map((job) => job.name))

const lines = readFileSync(requiredFile, 'utf8').split('\n')
const required = [...new Set(lines.filter((line) => !/^\s*(#|$)/.test(line)).map((line) => line.trimEnd()))].sort()
if (required.length === 0) {
  process.stderr.write(`FAIL: Required checks list is empty: ${requiredFile}\n`)
  process.exit(1)
}

const list = (items) => items.map((item) => `  - ${item}`).join('\n')
process.stdout.write(`\nPull-request workflows:\n${list(prWorkflows)}\n\nWorkflow jobs:\n${list([...jobNames].sort())}\n\nRequired checks:\n${list(required)}\n`)

const missing = required.filter((name) => !jobNames.has(name))
if (missing.length) {
  fail(`required check(s) missing from every pull-request workflow:\n${list(missing)}\n`)
  failures.push(`Every name in ${requiredFile} must be a job display name in a workflow under ${workflowsDir} that runs on pull_request.`)
  failures.push('A job with a matrix, or one that calls a reusable workflow, counts for no name. See .github/workflows/REQUIRED.md.')
}

const before = failures.length
const reported = new Set()
for (const name of required) {
  const jobs = suppliers.filter((job) => job.name === name)
  if (jobs.length > 1) fail(`required check ${name} is the name of ${jobs.length} jobs (${jobs.map((job) => `${job.label} line ${job.line} job ${job.id}`).join(', ')}); keep one`)
  for (const { label, id, job, read, on, pr } of jobs) {
    for (const { key } of job.items) {
      if (SKIPPING_KEYS.includes(key.value.toLowerCase())) fail(`${label} line ${read.lineOf(key)} job ${id} supplies required check ${name} and has ${key.value}:`)
    }
    const steps = read.field(job, 'steps')
    if (isSeq(steps)) {
      steps.items.forEach((item, index) => {
        const step = read.deref(item)
        const which = isMap(step) && textOf(read.field(step, 'name')) ? `${index + 1} (${textOf(read.field(step, 'name'))})` : `${index + 1}`
        if (!isMap(step)) fail(`${label} line ${read.lineOf(step)} job ${id} supplies required check ${name} and its step ${which} cannot be read`)
        else for (const { key } of step.items) if (key.value.toLowerCase() === 'continue-on-error') fail(`${label} line ${read.lineOf(key)} job ${id} supplies required check ${name} and its step ${which} has ${key.value}:`)
      })
    } else if (steps !== undefined && !isNull(steps)) fail(`${label} line ${read.lineOf(steps)} job ${id} supplies required check ${name} and its steps cannot be read`)
    if (!pr || reported.has(label)) continue
    reported.add(label)
    for (const filter of triggerFilters(on, read)) fail(`${label} supplies required check ${name} and its pull_request trigger has ${filter}`)
  }
}
if (failures.length > before) {
  failures.push('A skipped required job reports success, and a workflow that does not run leaves its check pending.')
  failures.push('A required job has no if:, needs: or continue-on-error: (on the job or on a step); its pull_request trigger holds only types:, with opened, synchronize and reopened. See .github/workflows/REQUIRED.md.')
}
if (failures.length) {
  process.stderr.write(`\n${failures.join('\n')}\n`)
  process.exit(1)
}
process.stdout.write('\nRequired job names are present in pull-request workflows.\n')
