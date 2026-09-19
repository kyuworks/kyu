import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWebResponse, resolveWebAsset } from './serveWeb.js'

// root sits inside parent, with a real file next to it (outside root) that a
// traversal would have to reach — so "returns undefined" proves the check
// fired, not just that nothing was there to find.
let parent: string
let root: string
let stolenFile: string

beforeEach(async () => {
  parent = await mkdtemp(path.join(tmpdir(), 'kyu-serve-web-'))
  root = path.join(parent, 'web')
  await mkdir(root)
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>shell</title>')
  await mkdir(path.join(root, 'assets'))
  await writeFile(path.join(root, 'assets', 'app.js'), 'console.log("app")')
  await writeFile(path.join(root, 'assets', 'app.css'), 'body { color: red }')
  stolenFile = path.join(parent, 'stolen.json')
  await writeFile(stolenFile, '{"secret":true}')
})

afterEach(async () => {
  await rm(parent, { recursive: true, force: true })
})

describe('readWebResponse', () => {
  it('refuses a path that climbs out of the web root, though the target file is real', async () => {
    // Proves the file exists, so "undefined" below means "refused", not "not found".
    await expect(readFile(stolenFile, 'utf8')).resolves.toContain('secret')

    const response = await readWebResponse(root, 'GET', '/../stolen.json')

    expect(response).toBeUndefined()
  })

  it('refuses the same climb percent-encoded', async () => {
    const response = await readWebResponse(root, 'GET', '/%2e%2e/stolen.json')

    expect(response).toBeUndefined()
  })

  it('serves an asset under the allowlist with its content type', async () => {
    const response = await readWebResponse(root, 'GET', '/assets/app.js')

    expect(response).toEqual({ status: 200, contentType: 'text/javascript', body: 'console.log("app")' })
  })

  it('returns the app shell for /', async () => {
    const response = await readWebResponse(root, 'GET', '/')

    expect(response).toEqual({ status: 200, contentType: 'text/html', body: '<!doctype html><title>shell</title>' })
  })

  it('returns the app shell for /bus, now that the bus page is React', async () => {
    const response = await readWebResponse(root, 'GET', '/bus')

    expect(response).toEqual({ status: 200, contentType: 'text/html', body: '<!doctype html><title>shell</title>' })
  })

  it('returns the app shell for /checkout, now that the shop pages are React', async () => {
    const response = await readWebResponse(root, 'GET', '/checkout')

    expect(response).toEqual({ status: 200, contentType: 'text/html', body: '<!doctype html><title>shell</title>' })
  })

  it('returns the app shell for /orders, now that the orders page is React', async () => {
    const response = await readWebResponse(root, 'GET', '/orders')

    expect(response).toEqual({ status: 200, contentType: 'text/html', body: '<!doctype html><title>shell</title>' })
  })

  it('returns the app shell for /warehouse, now that the warehouse page is React', async () => {
    const response = await readWebResponse(root, 'GET', '/warehouse')

    expect(response).toEqual({ status: 200, contentType: 'text/html', body: '<!doctype html><title>shell</title>' })
  })

  it('returns undefined for an unlisted route with no matching file', async () => {
    const response = await readWebResponse(root, 'GET', '/nope')

    expect(response).toBeUndefined()
  })

  it('returns undefined for a POST', async () => {
    const response = await readWebResponse(root, 'POST', '/assets/app.js')

    expect(response).toBeUndefined()
  })
})

// Exercised against resolveWebAsset directly, with no filesystem in the
// way: fs.readFile itself refuses an embedded NUL byte (Node throws
// ERR_INVALID_ARG_VALUE), so readWebResponse returns undefined either way
// and cannot tell the explicit check apart from that safety net. Testing
// the pure resolver instead proves this check on its own.
describe('resolveWebAsset', () => {
  it('refuses a NUL byte even with an allowlisted extension after it', () => {
    const asset = resolveWebAsset(root, '/index%00.json')

    expect(asset).toBeUndefined()
  })

  it('refuses a `..` segment that cancels itself out and would resolve inside root', () => {
    // path.resolve(root, './assets/../index.html') lands back on
    // root/index.html — safely inside root — so only the segment check
    // (not the resolved-path containment check) has a reason to refuse it.
    const asset = resolveWebAsset(root, '/assets/../index.html')

    expect(asset).toBeUndefined()
  })

  it('refuses a path outside the extension allowlist', () => {
    const asset = resolveWebAsset(root, '/assets/app.css.map.env')

    expect(asset).toBeUndefined()
  })

  it('resolves an asset under the allowlist to its file path and content type', () => {
    const asset = resolveWebAsset(root, '/assets/app.css')

    expect(asset).toEqual({ filePath: path.join(root, 'assets', 'app.css'), contentType: 'text/css' })
  })
})
