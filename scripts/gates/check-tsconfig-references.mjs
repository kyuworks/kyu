// Rules for check-tsconfig-references.sh. Exits 1 after printing each FAIL line.
//
// pnpm-workspace.yaml is read with workflow-yaml.mjs, so a file it cannot read fails. Its top-level
// packages: (that letter case) must be a list with at least one entry. Each entry must be text,
// either <dir>/* or a path, with no other glob character: the gate cannot tell which directories
// any other glob names, so it fails rather than check fewer packages. Each directory the entries
// name that holds a tsconfig.json must be a path in the root tsconfig.json's references.
//
// Usage: node check-tsconfig-references.mjs <root dir> <pnpm-workspace.yaml> <root tsconfig.json>
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { isSeq } from 'yaml'
import { readWorkflowYaml, textOf } from './workflow-yaml.mjs'

const GLOB_CHARACTER = /[*?[\]{}()!]/
const [root, workspaceFile, tsconfigFile] = process.argv.slice(2)
const label = path.basename(workspaceFile)
const failures = []
const fail = (msg) => failures.push(`FAIL: ${msg}`)

// The directories one packages: entry names, or undefined when the gate cannot expand it.
function entryDirs(entry) {
  const base = entry.endsWith('/*') ? entry.slice(0, -2) : entry
  if (GLOB_CHARACTER.test(base)) return undefined
  if (base === entry) return [entry]
  const baseDir = path.join(root, base)
  if (!existsSync(baseDir) || !statSync(baseDir).isDirectory()) return []
  return readdirSync(baseDir).sort().map((name) => path.join(base, name))
}

function workspaceDirs() {
  const read = readWorkflowYaml(workspaceFile, label, fail)
  if (read === null) return []
  const packages = read.deref(read.doc.contents.items.find((pair) => pair.key.value === 'packages')?.value)
  if (!isSeq(packages) || packages.items.length === 0) {
    fail(`${label} has no packages: list with an entry at the top level; the gate would check no package`)
    return []
  }
  return packages.items.flatMap((item) => {
    const entry = textOf(read.deref(item))
    const dirs = entry === undefined ? undefined : entryDirs(entry)
    if (dirs === undefined) fail(`${label} line ${read.lineOf(item)} has a packages: entry the gate cannot expand; write <dir>/* or a path`)
    return dirs ?? []
  })
}

const dirs = workspaceDirs()
if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
const tsconfig = JSON.parse(readFileSync(tsconfigFile, 'utf8'))
const refs = new Set((tsconfig.references ?? []).map((ref) => path.normalize(ref.path)))
const missing = dirs.filter((dir) => existsSync(path.join(root, dir, 'tsconfig.json')) && !refs.has(path.normalize(dir)))
if (missing.length > 0) {
  console.error(`FAIL: workspace package(s) with a tsconfig.json are missing from ${tsconfigFile} references:`)
  for (const dir of missing) console.error(`  - ${dir}`)
  console.error('pnpm typecheck runs tsc -b over the root references only; add the missing path(s).')
  process.exit(1)
}
console.log(`OK: every workspace package with a tsconfig.json is referenced from ${tsconfigFile}.`)
