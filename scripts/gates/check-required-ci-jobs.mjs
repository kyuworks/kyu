// Rules for check-required-ci-jobs.sh. Exits 1 after printing each FAIL line.
//
// A workflow runs on pull_request when on: is pull_request, a list that holds it, or a map
// with that key; pull_request_target does not count. A job's check name is its name:, else
// its job id. A job with a matrix, one that calls a reusable workflow, or a name: that holds ${{
// counts for no name: GitHub builds its check names at run time. Every workflow file is read with
// workflow-yaml.mjs, so a file it cannot read fails, pull-request workflow or not.
//
// Usage: node check-required-ci-jobs.mjs <workflows dir> <required-checks file>
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isMap, isSeq } from 'yaml'
import { isNull, listYamlFiles, readWorkflowYaml, textOf } from './workflow-yaml.mjs'

const PULL_REQUEST = 'pull_request'
const [workflowsDir, requiredFile] = process.argv.slice(2)
const failures = []
const fail = (msg) => failures.push(`FAIL: ${msg}`)

function runsOnPullRequest(on, read) {
  if (textOf(on) === PULL_REQUEST) return true
  if (isSeq(on)) return on.items.some((item) => textOf(read.deref(item)) === PULL_REQUEST)
  return isMap(on) && on.items.some((pair) => pair.key.value === PULL_REQUEST)
}

function checkNames(label, jobs, read) {
  const names = []
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
    if (isNull(name)) names.push(id)
    else if (textOf(name) !== undefined) names.push(textOf(name))
    else fail(`${label} line ${read.lineOf(name)} cannot read the name of job ${id}; write it as plain text`)
  }
  return names
}

const prWorkflows = []
const jobNames = new Set()
for (const name of listYamlFiles(workflowsDir, fail)) {
  const file = path.join(workflowsDir, name)
  const read = readWorkflowYaml(file, name, fail)
  if (!read || !runsOnPullRequest(read.field(read.doc.contents, 'on'), read)) continue
  prWorkflows.push(file)
  const jobs = read.field(read.doc.contents, 'jobs')
  if (isMap(jobs)) for (const job of checkNames(name, jobs, read)) jobNames.add(job)
  else if (!isNull(jobs)) fail(`${name} line ${read.lineOf(jobs)} cannot read jobs`)
}

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
if (failures.length) {
  process.stderr.write(`\n${failures.join('\n')}\n`)
  process.exit(1)
}
process.stdout.write('\nRequired job names are present in pull-request workflows.\n')
