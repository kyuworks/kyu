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
    const importStart = source.lastIndexOf('import', braceOpen)
    // "import type { … }" names no runtime component, so it needs no stylesheet.
    if (source.slice(importStart + 'import'.length, braceOpen).trim() === 'type') continue
    for (const raw of source.slice(braceOpen + 1, braceClose).split(',')) {
      const name = (raw.split(' as ')[0] ?? '').trim()
      if (name !== '') names.push(name)
    }
  }
}

// One entry per @heroui/react export family this app uses, to the component
// stylesheet(s) web/theme.css must import for it. An unmapped import name
// throws so a newly-used HeroUI component cannot ship silently unstyled —
// the failure that let a bare <Chip> render as plain text with no CSS.
// A component that composes shared markup (NumberField renders through the
// same input/label structure Input and TextField do) lists every stylesheet
// it depends on, not just its own, so dropping a shared one goes red here.
const HEROUI_STYLESHEETS_BY_PREFIX: readonly (readonly [string, readonly string[]])[] = [
  ['Card', ['card.css']],
  ['Alert', ['alert.css']],
  ['NumberField', ['number-field.css', 'input.css', 'label.css']],
  ['TextField', ['textfield.css']],
  ['Chip', ['chip.css']],
  ['Button', ['button.css']],
  ['Separator', ['separator.css']],
  ['Link', ['link.css']],
  ['Input', ['input.css']],
  ['Label', ['label.css']],
]

function stylesheetsFor(importName: string): readonly string[] {
  const entry = HEROUI_STYLESHEETS_BY_PREFIX.find(([prefix]) => importName.startsWith(prefix))
  if (entry === undefined) {
    throw new Error(
      `web/lib/herouiStyles.test.ts has no stylesheet mapping for the HeroUI import "${importName}". ` +
        'Add one, and import its stylesheet(s) in web/theme.css.',
    )
  }
  return entry[1]
}

describe('namedImportsFrom', () => {
  it('ignores a type-only import, which names no runtime component to style', () => {
    const source = "import type { ButtonProps } from '@heroui/react'\n"

    expect(namedImportsFrom(source)).toEqual([])
  })

  it('still collects a value import', () => {
    const source = "import { Alert, Button } from '@heroui/react'\n"

    expect(namedImportsFrom(source)).toEqual(['Alert', 'Button'])
  })
})

describe('stylesheetsFor', () => {
  it('maps NumberField to its own stylesheet plus the shared input and label stylesheets it composes from', () => {
    // A NumberFieldInput renders through the same input/label markup TextField and Input do —
    // if theme.css ever drops input.css or label.css, NumberField goes unstyled too. Listing
    // all three here means the gate below goes red if either shared file is ever removed.
    expect(stylesheetsFor('NumberFieldInput')).toEqual(['number-field.css', 'input.css', 'label.css'])
  })
})

describe('heroui component stylesheets', () => {
  it('imports a stylesheet in theme.css for every HeroUI component web/**/*.tsx uses', () => {
    const themeCss = readFileSync(join(WEB_DIR, 'theme.css'), 'utf8')
    const usedStylesheets = new Set<string>()

    for (const file of listTsxFiles(WEB_DIR)) {
      for (const name of namedImportsFrom(readFileSync(file, 'utf8'))) {
        for (const stylesheet of stylesheetsFor(name)) usedStylesheets.add(stylesheet)
      }
    }

    for (const stylesheet of usedStylesheets) {
      expect(themeCss).toContain(`components/${stylesheet}`)
    }
  })
})
