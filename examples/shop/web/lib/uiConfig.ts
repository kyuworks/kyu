import { z } from 'zod'

export interface UiConfig {
  dashboardUrl: string
}

export type UiConfigOutcome = { ok: true; config: UiConfig } | { ok: false; error: string }

const uiConfigSchema = z.object({ dashboardUrl: z.string() })

// Mirrors src/ui/handleRequest.ts's parseBody: the first Zod issue's path and message.
function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues.at(0)
  if (issue === undefined) return 'invalid response body'
  const path = issue.path.join('.')
  return path === '' ? issue.message : `${path}: ${issue.message}`
}

/** Parses a `GET /ui.json` body. The only place that body is looked at. */
export function parseUiConfig(body: string): UiConfigOutcome {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { ok: false, error: 'invalid JSON body' }
  }
  const result = uiConfigSchema.safeParse(json)
  if (!result.success) return { ok: false, error: firstIssueMessage(result.error) }
  return { ok: true, config: result.data }
}
