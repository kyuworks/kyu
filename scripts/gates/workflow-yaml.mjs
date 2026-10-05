// Reads one YAML file for the gates (a workflow, an action, compose.yaml) with the `yaml` package.
// It fails closed where this reader and GitHub's could differ: a parse error, not one
// document, a duplicate key (any letter case), a key that is not a string, a merge key,
// a tag, a %YAML or %TAG directive, an alias with no anchor or inside its own anchor,
// more aliases than MAX_ALIAS_COUNT, or a top level that is not a map.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { LineCounter, Parser, isAlias, isMap, isScalar, parseAllDocuments, visit } from 'yaml'

// GitHub reads YAML 1.2 without merge keys; anything the two readers could take differently fails.
const YAML_OPTIONS = { version: '1.2', schema: 'core', merge: false, strict: true, uniqueKeys: true }
const MAX_ALIAS_COUNT = 100

export const isNull = (node) => node === undefined || (isScalar(node) && node.value === null)
export const textOf = (node) => (isScalar(node) && typeof node.value === 'string' ? node.value : undefined)

// The .yml and .yaml files in dir, as names relative to it. A file whose extension is in
// another letter case (.YML) fails: GitHub's reading of it is not documented.
export function listYamlFiles(dir, fail, options = {}) {
  const names = []
  for (const name of readdirSync(dir, options).sort()) {
    if (!/\.ya?ml$/i.test(name) || !statSync(path.join(dir, name)).isFile()) continue
    if (/\.ya?ml$/.test(name)) names.push(name)
    else fail(`${name} has a workflow extension in another letter case; GitHub's reading of it is not documented, so rename it to .yml`)
  }
  return names
}

// Returns the document and line lookups, or null after passing each reason to fail().
export function readWorkflowYaml(file, label, fail) {
  let failed = false
  const report = (msg) => {
    failed = true
    fail(msg)
  }
  const source = readFileSync(file, 'utf8')
  const lines = new LineCounter()
  const docs = parseAllDocuments(source, { ...YAML_OPTIONS, lineCounter: lines })
  if (!Array.isArray(docs) || docs.length === 0) return report(`${label} holds no YAML document`), null
  if (docs.length > 1) return report(`${label} holds ${docs.length} YAML documents; GitHub reads one, so keep one`), null
  const [doc] = docs
  const lineAt = (offset) => lines.linePos(offset).line
  const lineOf = (node) => lineAt(node?.range?.[0] ?? 0)
  const [problem] = [...doc.errors, ...doc.warnings]
  if (problem) return report(`${label} line ${problem.linePos?.[0]?.line ?? 1} does not parse: ${problem.message.split(' at line ')[0]}`), null
  const tagDirective = [...new Parser().parse(source)].some((token) => token.type === 'directive' && token.source.startsWith('%TAG'))
  if (doc.directives.yaml.explicit || tagDirective) {
    return report(`${label} uses a %YAML or %TAG directive; the gate reads YAML 1.2 only, so remove it`), null
  }
  const anchors = new Set()
  visit(doc, {
    Alias(_, node, ancestors) {
      if (!anchors.has(node.source)) report(`${label} line ${lineOf(node)} uses alias *${node.source} with no anchor before it`)
      if (ancestors.some((up) => up.anchor === node.source)) report(`${label} line ${lineOf(node)} uses alias *${node.source} inside its own anchor`)
    },
    Node(_, node) {
      if (node.tag) report(`${label} line ${lineOf(node)} has a YAML tag (${node.tag}); write the value without it`)
      if (node.anchor) anchors.add(node.anchor)
      const seen = new Set()
      for (const { key } of isMap(node) ? node.items : []) {
        const folded = textOf(key)?.toLowerCase()
        if (folded !== undefined && seen.has(folded)) report(`${label} line ${lineOf(key)} repeats a key in another letter case`)
        seen.add(folded)
      }
    },
    Pair(_, pair) {
      const key = pair.key
      if (textOf(key) === undefined) {
        report(`${label} line ${lineOf(key)} has a key that is not a plain string; write it as text`)
      } else if (key.value === '<<') {
        report(`${label} line ${lineOf(key)} uses a YAML merge key; GitHub does not support merge keys, so write it out`)
      }
    },
  })
  if (failed) return null
  try {
    doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT, mapAsMap: true })
  } catch (e) {
    return report(`${label} cannot resolve its YAML aliases: ${e.message}`), null
  }
  if (!isMap(doc.contents)) return report(`${label} line ${lineOf(doc.contents)} is not a YAML map at the top level`), null
  const deref = (node) => (isAlias(node) ? node.resolve(doc) : node)
  // Keys match in any letter case: GitHub's own matching is not documented.
  const field = (map, name) => deref(map.items.find((pair) => pair.key.value.toLowerCase() === name)?.value)
  return { doc, source, lineAt, lineOf, field, deref }
}
