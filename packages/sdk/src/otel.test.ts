import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator, TraceState } from '@opentelemetry/core'
import { ROOT_CONTEXT, TraceFlags, context, propagation, trace } from '@opentelemetry/api'
import type { SpanContext } from '@opentelemetry/api'
import { defineEvent, envelopeSchema } from '@kyuworks/schemas'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Queryable, QueryParam, QueryRows } from './db/queryable.js'
import { createPublisher } from './outbox/publish.js'
import { activeTraceContext } from './otel.js'

const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
const spanId = '00f067aa0ba902b7'
const orderPlaced = defineEvent({ name: 'shop.order.placed', version: 1, data: z.object({ orderId: z.uuid() }) })

function withSpan<T>(spanContext: SpanContext, fn: () => T): T {
  return context.with(trace.setSpanContext(ROOT_CONTEXT, spanContext), fn)
}

describe('activeTraceContext', () => {
  beforeEach(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  })
  afterEach(() => {
    context.disable()
    propagation.disable()
  })

  it('returns an empty object when no span is active', () => {
    expect(activeTraceContext()).toEqual({})
  })

  it('returns an empty object when no global propagator is registered', () => {
    propagation.disable()
    const fields = withSpan({ traceId, spanId, traceFlags: TraceFlags.SAMPLED }, () => activeTraceContext())
    expect(fields).toEqual({})
  })

  it('returns the W3C traceparent of the active sampled span and no tracestate', () => {
    const fields = withSpan({ traceId, spanId, traceFlags: TraceFlags.SAMPLED }, () => activeTraceContext())
    expect(fields).toEqual({ traceparent: `00-${traceId}-${spanId}-01` })
    expect(fields.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  })

  it('returns traceparent and tracestate when the active span carries vendor state', () => {
    const traceState = new TraceState('rojo=00f067aa0ba902b7,congo=t61rcWkgMzE')
    const fields = withSpan({ traceId, spanId, traceFlags: TraceFlags.SAMPLED, traceState }, () => activeTraceContext())
    expect(fields).toEqual({
      traceparent: `00-${traceId}-${spanId}-01`,
      tracestate: 'rojo=00f067aa0ba902b7,congo=t61rcWkgMzE',
    })
  })

  it('leaves out a tracestate with no member', () => {
    const traceState = new TraceState('')
    const fields = withSpan({ traceId, spanId, traceFlags: TraceFlags.SAMPLED, traceState }, () => activeTraceContext())
    expect(fields).toEqual({ traceparent: `00-${traceId}-${spanId}-01` })
    expect(fields).not.toHaveProperty('tracestate')
  })

  it('returns only traceparent and tracestate when the propagator also injects other keys', () => {
    // A second setGlobalPropagator is ignored while one is registered.
    propagation.disable()
    propagation.setGlobalPropagator(
      new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
    )
    const baggage = propagation.createBaggage({ customer: { value: 'c-1' } })
    const active = propagation.setBaggage(
      trace.setSpanContext(ROOT_CONTEXT, { traceId, spanId, traceFlags: 1 }),
      baggage,
    )
    const carrier = new Map<string, string>()
    propagation.inject(active, carrier, { set: (map, key, value) => map.set(key, value) })
    expect([...carrier.keys()]).toEqual(['traceparent', 'baggage'])
    expect(context.with(active, () => activeTraceContext())).toEqual({ traceparent: `00-${traceId}-${spanId}-01` })
  })

  it('returns an empty object when a propagator injects a tracestate without a traceparent', () => {
    propagation.disable()
    const fields = ['tracestate']
    propagation.setGlobalPropagator({
      inject: (_context, carrier, setter) => setter.set(carrier, 'tracestate', 'rojo=00f067aa0ba902b7'),
      extract: (active) => active,
      fields: () => fields,
    })
    expect(withSpan({ traceId, spanId, traceFlags: TraceFlags.SAMPLED }, () => activeTraceContext())).toEqual({})
  })

  it('reads the span that is active across an await', async () => {
    const fields = await withSpan({ traceId, spanId, traceFlags: TraceFlags.SAMPLED }, async () => {
      await Promise.resolve()
      return activeTraceContext()
    })
    expect(fields).toEqual({ traceparent: `00-${traceId}-${spanId}-01` })
  })

  it('feeds publish() so the stored envelope carries the active span context', async () => {
    const recordedParams: Array<readonly QueryParam[]> = []
    const db: Queryable = {
      query(_text: string, params: readonly QueryParam[]): Promise<QueryRows> {
        recordedParams.push(params)
        return Promise.resolve({ rows: [], rowCount: 1 })
      },
    }
    const publisher = createPublisher({ source: 'shop-service' })
    const tenantId = '018f0000-0000-7000-8000-0000000000aa'
    const traceState = new TraceState('rojo=00f067aa0ba902b7')
    await withSpan({ traceId, spanId, traceFlags: TraceFlags.SAMPLED, traceState }, () =>
      publisher.publish(
        db,
        orderPlaced,
        { orderId: '018f0000-0000-7000-8000-000000000002' },
        { tenantId, ...activeTraceContext() },
      ),
    )
    const stored = envelopeSchema.parse(JSON.parse(z.string().parse(recordedParams[0]?.[3])))
    expect(stored.traceparent).toBe(`00-${traceId}-${spanId}-01`)
    expect(stored.tracestate).toBe('rojo=00f067aa0ba902b7')
    expect(stored.tenantId).toBe(tenantId)
  })
})
