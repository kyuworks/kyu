import { z } from 'zod'

const topologyDoneOutcomeSchema = z.object({ handler: z.string(), label: z.string() })
const topologyWakeSchema = z.object({ messageName: z.string(), label: z.string() })
const topologySubscriptionSchema = z.object({
  name: z.string(),
  messageName: z.string(),
  kind: z.enum(['event', 'command']),
  doneOutcomes: z.array(topologyDoneOutcomeSchema).optional(),
  waitingHandler: z.string().optional(),
  wakesOn: topologyWakeSchema.optional(),
})
const busTopologySchema = z.object({
  producer: z.object({ source: z.string() }),
  subscriptions: z.array(topologySubscriptionSchema),
})

const producerCountsSchema = z.object({ source: z.string(), published: z.number() })
const outboxCountsSchema = z.object({ published: z.number(), waitingForRelay: z.number(), shipped: z.number() })
const doneOutcomeCountSchema = z.object({ label: z.string(), count: z.number() })
const subscriptionRunCountsSchema = z.object({
  name: z.string(),
  queued: z.number(),
  running: z.number(),
  completed: z.number(),
  failed: z.number(),
  cancelled: z.number(),
  parked: z.number().optional(),
  doneOutcomes: z.array(doneOutcomeCountSchema).optional(),
})
const countsWindowSchema = z.object({ limit: z.number(), envelopes: z.number(), engineCalls: z.number() })
const busCountsSchema = z.object({
  producers: z.array(producerCountsSchema),
  outbox: outboxCountsSchema,
  subscriptions: z.array(subscriptionRunCountsSchema),
  window: countsWindowSchema,
})

const busDocumentSchema = z.object({ topology: busTopologySchema, counts: busCountsSchema })

export type BusDocument = z.infer<typeof busDocumentSchema>
export type BusDocumentOutcome = { ok: true; document: BusDocument } | { ok: false; error: string }

// Mirrors src/ui/handleRequest.ts's parseBody: the first Zod issue's path and message.
function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues.at(0)
  if (issue === undefined) return 'invalid response body'
  const path = issue.path.join('.')
  return path === '' ? issue.message : `${path}: ${issue.message}`
}

/** Parses a `GET /bus.json` body. The only place that body is looked at. */
export function parseBusDocument(body: string): BusDocumentOutcome {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { ok: false, error: 'invalid JSON body' }
  }
  const result = busDocumentSchema.safeParse(json)
  if (!result.success) return { ok: false, error: firstIssueMessage(result.error) }
  return { ok: true, document: result.data }
}
