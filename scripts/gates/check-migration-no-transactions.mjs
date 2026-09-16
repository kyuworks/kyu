// check-migration-no-transactions.mjs — tokenizer for the gate in
// check-migration-no-transactions.sh. A migration file must not contain its
// own transaction control statements; the applier wraps each file in one
// transaction (packages/sdk/vitest.integration.setup.ts). CREATE INDEX
// CONCURRENTLY fails for the same reason: it cannot run inside that
// per-file transaction.
//
// Strips `--` comments, `/* */` comments, '...' strings and dollar-quoted
// bodies ($$...$$, $tag$...$tag$) before splitting on `;`, so a PL/pgSQL
// `BEGIN ... END;` body or a literal string does not trip the gate.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const BLOCKED = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'START', 'END'])

// Strip comments, strings and dollar-quoted bodies; keep `;` and keywords.
function stripNoise(sql) {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const two = sql.slice(i, i + 2)
    if (two === '--') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? n : nl
      continue
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (sql[i] === "'") {
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2
        else if (sql[j] === "'") {
          j += 1
          break
        } else j += 1
      }
      i = j
      continue
    }
    if (sql[i] === '$') {
      const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const close = sql.indexOf(tag, i + tag.length)
        i = close === -1 ? n : close + tag.length
        continue
      }
    }
    out += sql[i]
    i += 1
  }
  return out
}

// Returns a failure message, or null when the file is clean.
function checkFile(file) {
  const statements = stripNoise(readFileSync(file, 'utf8')).split(';')
  let index = 0
  for (const statement of statements) {
    index += 1
    const trimmed = statement.trim()
    if (trimmed === '') continue
    const wordMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed)
    if (!wordMatch) continue
    const word = wordMatch[1].toUpperCase()

    if (/\bCONCURRENTLY\b/i.test(trimmed)) {
      return `statement ${index} uses CREATE INDEX CONCURRENTLY, which cannot run inside the per-file transaction that runners apply migrations in`
    }
    if (word === 'PREPARE') {
      if (/^PREPARE\s+TRANSACTION\b/i.test(trimmed)) return `statement ${index} starts with ${word}`
      continue
    }
    if (word === 'START') {
      if (/^START\s+TRANSACTION\b/i.test(trimmed)) return `statement ${index} starts with ${word}`
      continue
    }
    if (BLOCKED.has(word)) return `statement ${index} starts with ${word}`
  }
  return null
}

function main() {
  const migrationsDir = process.env['MIGRATIONS_DIR']
  if (!migrationsDir) {
    console.error('FAIL: MIGRATIONS_DIR is not set')
    process.exit(1)
  }

  let entries
  try {
    entries = readdirSync(migrationsDir)
  } catch {
    console.log('OK: no migrations directory.')
    return
  }

  const files = entries
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => path.join(migrationsDir, name))

  let failed = false
  for (const file of files) {
    const problem = checkFile(file)
    if (problem) {
      console.error(`FAIL: ${file}: ${problem}`)
      failed = true
    }
  }

  if (failed) process.exit(1)
  console.log(`OK: ${files.length} migration(s) checked`)
}

main()
