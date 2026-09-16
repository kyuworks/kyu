// Map changed paths to check steps. Prints "name<TAB>command" lines for
// scripts/check.sh. Reads the staged index with --staged, else
// CHECK_CHANGED_RANGE, else the working tree plus untracked files against the
// merge-base with origin/main.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const staged = process.argv.includes('--staged')

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: cleanGitEnv() }).trim()
}

function cleanGitEnv() {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  return env
}

function changedFiles() {
  if (staged) return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n')
  const range = process.env.CHECK_CHANGED_RANGE
  if (range) return git(['diff', '--name-only', '--diff-filter=ACMR', range]).split('\n')
  let base = ''
  for (const cand of ['origin/main', 'main']) {
    try {
      base = git(['merge-base', cand, 'HEAD'])
      break
    } catch {
      /* try the next candidate */
    }
  }
  const tracked = base ? git(['diff', '--name-only', '--diff-filter=ACMR', base]).split('\n') : []
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n')
  return [...tracked, ...untracked]
}

// Workspace graph: package dir -> { name, deps: [package dir...] }
function workspace() {
  const pkgsDir = path.join(root, 'packages')
  const out = new Map()
  if (!existsSync(pkgsDir)) return out
  for (const dir of readdirSync(pkgsDir)) {
    const pj = path.join(pkgsDir, dir, 'package.json')
    if (!existsSync(pj)) continue
    const json = JSON.parse(readFileSync(pj, 'utf8'))
    out.set(`packages/${dir}`, { name: json.name, deps: Object.keys({ ...json.dependencies, ...json.devDependencies }) })
  }
  return out
}

const ws = workspace()
const byName = new Map([...ws].map(([dir, v]) => [v.name, dir]))

function dependants(dir, acc = new Set()) {
  for (const [other, v] of ws) {
    const depDirs = v.deps.map((n) => byName.get(n)).filter(Boolean)
    if (depDirs.includes(dir) && !acc.has(other)) {
      acc.add(other)
      dependants(other, acc)
    }
  }
  return acc
}

const steps = new Map()
const add = (id, cmd) => {
  if (!steps.has(id)) steps.set(id, cmd)
}
const formatFiles = []
let allGates = false
let lintAll = false

for (const raw of changedFiles()) {
  const f = raw.trim()
  if (!f) continue
  if (/\.(ts|tsx|mts|cts|json|css)$/.test(f) && !f.startsWith('oxlint-rules/anti-slop/') && !f.includes('/migrations/')) {
    formatFiles.push(f)
  }
  const pkg = [...ws.keys()].find((d) => f.startsWith(d + '/'))
  if (pkg) {
    if (f.startsWith(`${pkg}/migrations/`)) add('gate:migration-immutability', 'bash scripts/gates/check-migration-immutability.sh')
    for (const d of [pkg, ...dependants(pkg)]) {
      const name = ws.get(d).name
      add(`lint:${d}`, `pnpm --filter ${name} lint`)
      add(`typecheck:${d}`, `pnpm --filter ${name} typecheck`)
      add(`test:${d}`, `pnpm --filter ${name} test`)
    }
    continue
  }
  if (f.startsWith('oxlint-rules/')) lintAll = true
  if (f.startsWith('scripts/gates/') || f === 'scripts/verify-gates.sh' || f.startsWith('.github/workflows/')) allGates = true
  if (f.endsWith('.sh')) {
    const suite = f.endsWith('.test.sh') ? f : f.slice(0, -3) + '.test.sh'
    if (existsSync(path.join(root, suite))) add(`selftest:${suite}`, `bash ${suite}`)
  }
}

if (lintAll) for (const [d, v] of ws) add(`lint:${d}`, `pnpm --filter ${v.name} lint`)
if (allGates) add('gates', 'bash scripts/verify-gates.sh')
if (formatFiles.length) {
  const cmd = staged ? 'bash scripts/lib/check-staged-format.sh' : `pnpm exec oxfmt --check --ignore-path .oxfmtignore ${formatFiles.map((f) => JSON.stringify(f)).join(' ')}`
  add('format', cmd)
}

// check.sh runs a leading `gates` step and lint/typecheck steps serially, then
// the rest in parallel. Order: gates, format, lint..., typecheck..., tests.
const order = (id) => (id === 'gates' ? 0 : id === 'format' ? 1 : id.startsWith('lint') ? 2 : id.startsWith('typecheck') ? 3 : 4)
const lines = [...steps].sort((a, b) => order(a[0]) - order(b[0])).map(([id, cmd]) => `${id}\t${cmd}`)
process.stdout.write(lines.join('\n'))
