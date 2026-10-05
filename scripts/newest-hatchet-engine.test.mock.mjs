// A stand-in for fetch, loaded by newest-hatchet-engine.test.sh with NODE_OPTIONS=--import.
// MOCK picks how ghcr.io answers; MOCK_NO_IMAGE is a comma list of tags whose manifest is 404.
// It answers only https://ghcr.io and only to the token below, so a request that leaks the
// token elsewhere, or sends none, throws or gets a 401.
const TOKEN = 'SECRETTOKEN123'
const LIST = '/v2/hatchet-dev/hatchet/hatchet-lite/tags/list'
const MANIFEST = '/v2/hatchet-dev/hatchet/hatchet-lite/manifests/'
const mode = process.env.MOCK
const noImage = (process.env.MOCK_NO_IMAGE ?? '').split(',')
const answer = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
const next = (target) => ({ link: `<${target}>; rel="next"` })

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  if (url.origin !== 'https://ghcr.io') throw new Error(`request to ${url.origin}`)
  if (url.pathname === '/token') {
    if (mode === 'token-401') return answer(401, { errors: [] })
    return answer(200, mode === 'token-empty' ? {} : { token: TOKEN })
  }
  if (init.headers?.authorization !== `Bearer ${TOKEN}`) return answer(401, { errors: [] })
  if (mode === 'throws') throw new Error('connect ECONNREFUSED')
  if (url.pathname.startsWith(MANIFEST)) {
    if (!init.headers.accept?.includes('application/vnd.oci.image.index.v1+json')) return answer(400, {})
    if (mode === 'manifest-throws') throw new Error('connect ECONNRESET')
    if (mode === 'manifest-500') return answer(500, {})
    return answer(noImage.includes(url.pathname.slice(MANIFEST.length)) ? 404 : 200, {})
  }
  if (url.pathname !== LIST) return answer(404, {})
  if (mode === 'list-401') return answer(401, { errors: [] })
  if (mode === 'list-500') return answer(500, {})
  if (mode === 'not-json') return answer(200, '<html>')
  if (mode === 'no-tags') return answer(200, { name: 'x', tags: null })
  if (mode === 'loop') return answer(200, { tags: ['v0.107.0'] }, next(`${LIST}?last=x&n=1000`))
  if (mode === 'link-absolute') return answer(200, { tags: ['v0.107.0'] }, next('https://evil.example/v2/x'))
  if (mode === 'link-protocol') return answer(200, { tags: ['v0.107.0'] }, next('//evil.example/v2/x'))
  if (url.searchParams.has('last')) return answer(200, { tags: ['v0.110.2', 'v0.109.9', 'v0.110.2-amd64'] })
  return answer(200, { tags: ['v0.107.0', 'v0.108.0', 'latest'] }, next(`${LIST}?last=latest&n=1000`))
}
