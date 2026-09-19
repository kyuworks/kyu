import fs from 'node:fs/promises'
import path from 'node:path'
import type { UiResponse } from './handleRequest.js'

// The allowlist and the utf8 read below are text-only by design: a binary
// asset (an image, a font) needs both changed, not just the map extended.
const CONTENT_TYPES = new Map<string, string>([
  ['.html', 'text/html'],
  ['.js', 'text/javascript'],
  ['.css', 'text/css'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json'],
  ['.map', 'application/json'],
])

/** The urls that return the app shell. One entry per page; never a wildcard. */
const APP_ROUTES = new Set(['/'])

export interface WebAsset {
  filePath: string
  contentType: string
}

// Every reason to refuse a url is checked before the file is ever read:
// wrong method, a malformed escape, a NUL or `..` segment, a resolved path
// outside root, or an extension outside the allowlist. Exported so a test
// can prove each check independently, without a filesystem in the way.
export function resolveWebAsset(root: string, url: string): WebAsset | undefined {
  const cut = url.split(/[?#]/)[0] ?? ''
  if (APP_ROUTES.has(cut)) return { filePath: path.join(root, 'index.html'), contentType: 'text/html' }

  let decoded: string
  try {
    decoded = decodeURIComponent(cut)
  } catch {
    return undefined
  }

  if (decoded.includes('\0')) return undefined
  if (decoded.split('/').includes('..')) return undefined

  const resolved = path.resolve(root, `.${decoded}`)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined

  const contentType = CONTENT_TYPES.get(path.extname(resolved))
  if (contentType === undefined) return undefined

  return { filePath: resolved, contentType }
}

/** Reads one file under `root` for a GET, or undefined when the url is not this app's. */
export async function readWebResponse(root: string, method: string, url: string): Promise<UiResponse | undefined> {
  if (method !== 'GET') return undefined
  const asset = resolveWebAsset(root, url)
  if (asset === undefined) return undefined
  try {
    const body = await fs.readFile(asset.filePath, 'utf8')
    return { status: 200, contentType: asset.contentType, body }
  } catch {
    return undefined
  }
}
