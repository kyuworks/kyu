import { z } from 'zod'

/** What every polling hook normalizes a `fetch` response into before parsing the body. */
export interface JsonFetchOutcome {
  ok: boolean
  status: number
  bodyText: string
}

const errorBodySchema = z.object({ error: z.string() })

// The server's own { error } message (src/ui/handleRequest.ts's
// errorResponse) when the body has that shape, else the status code.
// Shared by every fetch on this page.
export function describeFetchFailure(status: number, bodyText: string): string {
  let json: unknown
  try {
    json = JSON.parse(bodyText)
  } catch {
    return `HTTP ${status}`
  }
  const result = errorBodySchema.safeParse(json)
  return result.success ? result.data.error : `HTTP ${status}`
}

// Mirrors src/ui/handleRequest.ts's parseBody: the first Zod issue's path and message.
export function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues.at(0)
  if (issue === undefined) return 'invalid response body'
  const path = issue.path.join('.')
  return path === '' ? issue.message : `${path}: ${issue.message}`
}
