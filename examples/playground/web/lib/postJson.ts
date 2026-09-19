export interface PostOutcome {
  ok: boolean
  body: string
}

/** One POST helper every publish path uses: fetch, then the response text, unparsed. */
export async function postJson(path: string, payload: string): Promise<PostOutcome> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })
  const body = await response.text()
  return { ok: response.ok, body }
}
