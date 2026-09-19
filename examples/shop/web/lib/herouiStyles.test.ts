import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB_DIR = join(import.meta.dirname, '..')

function listTsxFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...listTsxFiles(full))
      continue
    }
    if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) files.push(full)
  }
  return files
}

const HEROUI_IMPORT_MARKER = "from '@heroui/react'"

// String search rather than a regex capture group: this repo's two type
// checkers (tsc and oxlint-tsgolint) disagree on whether a literal regex's
// capture group can be undefined, so a plain indexOf/lastIndexOf pair keeps
// both satisfied without an assertion either tool would flag.
function namedImportsFrom(source: string): string[] {
  const names: string[] = []
  let searchFrom = 0
  for (;;) {
    const markerStart = source.indexOf(HEROUI_IMPORT_MARKER, searchFrom)
    if (markerStart === -1) return names
    searchFrom = markerStart + HEROUI_IMPORT_MARKER.length
    const braceClose = source.lastIndexOf('}', markerStart)
    const braceOpen = source.lastIndexOf('{', braceClose)
    if (braceOpen === -1 || braceClose === -1) continue
    for (const raw of source.slice(braceOpen + 1, braceClose).split(',')) {
      const name = (raw.split(' as ')[0] ?? '').trim()
      if (name !== '') names.push(name)
    }
  }
}

// One entry per @heroui/react export family this app uses, to the component
// stylesheet web/theme.css must import for it. An unmapped import name
// throws so a newly-used HeroUI component cannot ship silently unstyled —
// the failure that let a bare <Chip> render as plain text with no CSS.
const HEROUI_STYLESHEET_BY_PREFIX: readonly (readonly [string, string])[] = [
  ['Card', 'card.css'],
  ['Alert', 'alert.css'],
  ['NumberField', 'number-field.css'],
  ['TextField', 'textfield.css'],
  ['Chip', 'chip.css'],
  ['Button', 'button.css'],
  ['Separator', 'separator.css'],
  ['Link', 'link.css'],
  ['Input', 'input.css'],
  ['Label', 'label.css'],
]

function stylesheetFor(importName: string): string {
  const entry = HEROUI_STYLESHEET_BY_PREFIX.find(([prefix]) => importName.startsWith(prefix))
  if (entry === undefined) {
    throw new Error(
      `web/lib/herouiStyles.test.ts has no stylesheet mapping for the HeroUI import "${importName}". ` +
        'Add one, and import its stylesheet in web/theme.css.',
    )
  }
  return entry[1]
}

describe('heroui component stylesheets', () => {
  it('imports a stylesheet in theme.css for every HeroUI component web/**/*.tsx uses', () => {
    const themeCss = readFileSync(join(WEB_DIR, 'theme.css'), 'utf8')
    const usedStylesheets = new Set<string>()

    for (const file of listTsxFiles(WEB_DIR)) {
      for (const name of namedImportsFrom(readFileSync(file, 'utf8'))) {
        usedStylesheets.add(stylesheetFor(name))
      }
    }

    for (const stylesheet of usedStylesheets) {
      expect(themeCss).toContain(`components/${stylesheet}`)
    }
  })
})
