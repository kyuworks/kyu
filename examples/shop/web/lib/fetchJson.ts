import { z } from 'zod'

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
