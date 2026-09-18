import type { Kinesin } from '@kinesin/sdk'
import { uuidv7 } from '@kinesin/sdk'
import type { Pool } from 'pg'
import type { z } from 'zod'
import { describeError, log } from '../log.js'
import { placeOrder } from '../producer/placeOrder.js'
import { shipOrder } from '../producer/shipOrder.js'
import { renderUiPage } from './page.js'
import type { PlaceOrderRequest, ShipOrderRequest } from './requests.js'
import { placeOrderRequestSchema, shipOrderRequestSchema } from './requests.js'

export interface UiRequestDeps {
  pool: Pool
  kinesin: Kinesin
  dashboardUrl: string
}

export interface UiRequest {
  method: string
  url: string
  // The request's own Content-Type header; '' when absent. Unused for GET.
  contentType: string
  body: string
}

export interface UiResponse {
  status: number
  contentType: string
  body: string
}

// A local dev form never sends more; a limit keeps a stray large body from
// being parsed at all.
const MAX_BODY_BYTES = 64 * 1024

function jsonResponse<T>(status: number, value: T): UiResponse {
  return { status, contentType: 'application/json', body: JSON.stringify(value) }
}

function errorResponse(status: number, message: string): UiResponse {
  return jsonResponse(status, { error: message })
}

function isJsonContentType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('application/json')
}

// Runs before a POST body is even looked at: too large or the wrong content
// type never reaches JSON.parse or a producer.
function checkPostBody(request: UiRequest): UiResponse | undefined {
  if (Buffer.byteLength(request.body, 'utf8') > MAX_BODY_BYTES) {
    return errorResponse(413, `request body exceeds ${MAX_BODY_BYTES} bytes`)
  }
  if (!isJsonContentType(request.contentType)) {
    return errorResponse(415, 'content-type must be application/json')
  }
  return undefined
}

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

// The first Zod issue's path and message, e.g. "tenantId: Invalid UUID".
function firstIssueMessage(error: z.ZodError): string {
  const [issue] = error.issues
  if (issue === undefined) return 'invalid request body'
  const path = issue.path.join('.')
  return path === '' ? issue.message : `${path}: ${issue.message}`
}

// The trust edge: invalid JSON or a schema failure never reaches a producer,
// so the pool is never touched.
function parseBody<T>(schema: z.ZodType<T>, body: string): ParseOutcome<T> {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { ok: false, error: 'invalid JSON body' }
  }
  const result = schema.safeParse(json)
  if (!result.success) return { ok: false, error: firstIssueMessage(result.error) }
  return { ok: true, value: result.data }
}

async function handlePlaceOrder(deps: UiRequestDeps, body: string): Promise<UiResponse> {
  const parsed = parseBody<PlaceOrderRequest>(placeOrderRequestSchema, body)
  if (!parsed.ok) return errorResponse(400, parsed.error)
  try {
    const placed = await placeOrder(deps.pool, deps.kinesin, {
      tenantId: parsed.value.tenantId,
      customerId: parsed.value.customerId ?? uuidv7(),
    })
    return jsonResponse(201, {
      orderId: placed.orderId,
      invoiceId: placed.invoiceId,
      orderPlacedEnvelopeId: placed.envelopeIds.orderPlaced,
      sendInvoiceEnvelopeId: placed.envelopeIds.sendInvoice,
    })
  } catch (error) {
    log('ui', 'failed', { message: describeError(error) })
    return errorResponse(500, describeError(error))
  }
}

async function handleShipOrder(deps: UiRequestDeps, body: string): Promise<UiResponse> {
  const parsed = parseBody<ShipOrderRequest>(shipOrderRequestSchema, body)
  if (!parsed.ok) return errorResponse(400, parsed.error)
  try {
    const envelopeId = await shipOrder(deps.pool, deps.kinesin, {
      tenantId: parsed.value.tenantId,
      orderId: parsed.value.orderId,
      carrier: parsed.value.carrier ?? 'unspecified',
    })
    return jsonResponse(201, { orderId: parsed.value.orderId, envelopeId })
  } catch (error) {
    log('ui', 'failed', { message: describeError(error) })
    return errorResponse(500, describeError(error))
  }
}

/** Routes the playground's local web page: `GET /`, `POST /orders`, `POST /shipments`. */
export async function handleUiRequest(deps: UiRequestDeps, request: UiRequest): Promise<UiResponse> {
  if (request.method === 'GET' && request.url === '/') {
    return { status: 200, contentType: 'text/html', body: renderUiPage(deps.dashboardUrl) }
  }
  if (request.method === 'POST' && request.url === '/orders') {
    return checkPostBody(request) ?? handlePlaceOrder(deps, request.body)
  }
  if (request.method === 'POST' && request.url === '/shipments') {
    return checkPostBody(request) ?? handleShipOrder(deps, request.body)
  }
  return errorResponse(404, `no route for ${request.method} ${request.url}`)
}
