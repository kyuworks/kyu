import { context, defaultTextMapSetter, propagation } from '@opentelemetry/api'
import type { PublisherOptions } from './outbox/publish.js'

export type ActiveTraceContext = Pick<PublisherOptions, 'traceparent' | 'tracestate'>

/** The W3C trace context of the active span, as the global propagator injects it; `{}` with no span or no propagator. */
export function activeTraceContext(): ActiveTraceContext {
  const carrier: ActiveTraceContext = {}
  propagation.inject(context.active(), carrier, defaultTextMapSetter)
  const traceContext: ActiveTraceContext = {}
  if (carrier.traceparent === undefined) return traceContext
  traceContext.traceparent = carrier.traceparent
  // A tracestate with no member carries nothing; createEnvelope drops it too.
  if (carrier.tracestate !== undefined && carrier.tracestate !== '') traceContext.tracestate = carrier.tracestate
  return traceContext
}
