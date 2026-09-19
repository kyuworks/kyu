import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWebResponse } from './serveWeb.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'qtaxis-serve-web-'))
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>shell</title>')
  await mkdir(path.join(root, 'assets'))
  await writeFile(path.join(root, 'assets', 'app.js'), 'console.log("app")')
  await writeFile(path.join(root, 'assets', 'app.css'), 'body { color: red }')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('readWebResponse', () => {
  it('refuses a path that climbs out of the web root', async () => {
    const response = await readWebResponse(root, 'GET', '/../../package.json')

    expect(response).toBeUndefined()
  })

  it('refuses an encoded traversal', async () => {
    const response = await readWebResponse(root, 'GET', '/%2e%2e/%2e%2e/package.json')

    expect(response).toBeUndefined()
  })

  it('refuses a NUL byte in the path', async () => {
    const response = await readWebResponse(root, 'GET', '/assets/app.js%00.png')

    expect(response).toBeUndefined()
  })

  it('refuses a path outside the extension allowlist', async () => {
    await writeFile(path.join(root, 'assets', 'secret.env'), 'SECRET=1')

    const response = await readWebResponse(root, 'GET', '/assets/secret.env')

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

  it('returns the app shell for /bus', async () => {
    const response = await readWebResponse(root, 'GET', '/bus')

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
