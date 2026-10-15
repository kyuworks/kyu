import { createEnvelope, defineEvent, envelopeSchema } from '@kyuworks/schemas'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Queryable, QueryParam, QueryRows } from '../db/queryable.js'
import { SDK_VERSION } from '../version.js'
import { createPublisher, publishEnvelope } from './publish.js'

const orderPlaced = defineEvent({ name: 'shop.order.placed', version: 1, data: z.object({ orderId: z.uuid() }) })

describe('createPublisher', () => {
  it('stamps the configured source and inserts a jsonb param that round-trips through envelopeSchema', async () => {
    const recordedParams: Array<readonly QueryParam[]> = []
    const db: Queryable = {
      query(_text: string, params: readonly QueryParam[]): Promise<QueryRows> {
        recordedParams.push(params)
        return Promise.resolve({ rows: [], rowCount: 1 })
      },
    }

    const publisher = createPublisher({ source: 'shop-service' })
    const envelope = await publisher.publish(
      db,
      orderPlaced,
      { orderId: '018f0000-0000-7000-8000-000000000002' },
      { tenantId: null },
    )

    expect(envelope.source).toBe('shop-service')
    expect(recordedParams).toHaveLength(1)
    const jsonParam = z.string().parse(recordedParams[0]?.[3])
    const roundTripped = envelopeSchema.parse(JSON.parse(jsonParam))
    expect(roundTripped).toEqual(envelope)
  })

  it('writes a given traceparent and tracestate into the stored envelope', async () => {
    const recordedParams: Array<readonly QueryParam[]> = []
    const db: Queryable = {
      query(_text: string, params: readonly QueryParam[]): Promise<QueryRows> {
        recordedParams.push(params)
        return Promise.resolve({ rows: [], rowCount: 1 })
      },
    }
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const tracestate = 'rojo=00f067aa0ba902b7'
    const publisher = createPublisher({ source: 'shop-service' })
    await publisher.publish(
      db,
      orderPlaced,
      { orderId: '018f0000-0000-7000-8000-000000000002' },
      { tenantId: null, traceparent, tracestate },
    )
    const stored = envelopeSchema.parse(JSON.parse(z.string().parse(recordedParams[0]?.[3])))
    expect(stored.traceparent).toBe(traceparent)
    expect(stored.tracestate).toBe(tracestate)
  })

  it('passes publishAt through as the insert’s publish_at parameter', async () => {
    const recordedParams: Array<readonly QueryParam[]> = []
    const db: Queryable = {
      query(_text: string, params: readonly QueryParam[]): Promise<QueryRows> {
        recordedParams.push(params)
        return Promise.resolve({ rows: [], rowCount: 1 })
      },
    }
    const publishAt = new Date('2030-01-01T00:00:00.000Z')
    const publisher = createPublisher({ source: 'shop-service' })
    await publisher.publish(
      db,
      orderPlaced,
      { orderId: '018f0000-0000-7000-8000-000000000002' },
      { tenantId: null, publishAt },
    )
    expect(recordedParams[0]?.[4]).toEqual(publishAt)
  })

  it('omits publish_at when publishAt is not given, so the column defaults to now', async () => {
    const recordedParams: Array<readonly QueryParam[]> = []
    const db: Queryable = {
      query(_text: string, params: readonly QueryParam[]): Promise<QueryRows> {
        recordedParams.push(params)
        return Promise.resolve({ rows: [], rowCount: 1 })
      },
    }
    const publisher = createPublisher({ source: 'shop-service' })
    await publisher.publish(db, orderPlaced, { orderId: '018f0000-0000-7000-8000-000000000002' }, { tenantId: null })
    expect(recordedParams[0]?.[4]).toBeNull()
  })

  it('rejects an invalid publishAt before touching the database', async () => {
    let calls = 0
    const db: Queryable = {
      query(_text: string, _params: readonly QueryParam[]): Promise<QueryRows> {
        calls += 1
        return Promise.resolve({ rows: [], rowCount: 1 })
      },
    }
    const publisher = createPublisher({ source: 'shop-service' })
    await expect(
      publisher.publish(
        db,
        orderPlaced,
        { orderId: '018f0000-0000-7000-8000-000000000002' },
        { tenantId: null, publishAt: new Date('nonsense') },
      ),
    ).rejects.toThrow(RangeError)
    expect(calls).toBe(0)
  })

  it('exposes tenants alongside publish, so a database-only process (no engine token) can pause/resume a tenant', () => {
    const publisher = createPublisher({ source: 'shop-service' })
    expect(Object.keys(publisher).sort()).toEqual(['publish', 'tenants'])
  })
})

describe('publishEnvelope', () => {
  it('stores and returns the envelope with SDK_VERSION in sdkVersion, replacing a caller value', async () => {
    const recordedParams: Array<readonly QueryParam[]> = []
    const db: Queryable = {
      query(_text: string, params: readonly QueryParam[]): Promise<QueryRows> {
        recordedParams.push(params)
        return Promise.resolve({ rows: [], rowCount: 1 })
      },
    }
    const created = await createEnvelope(
      orderPlaced,
      { orderId: '018f0000-0000-7000-8000-000000000002' },
      { tenantId: null, source: 'shop-service' },
    )

    const returned = await publishEnvelope(db, { ...created, sdkVersion: '0.0.0-caller' })

    const stored = envelopeSchema.parse(JSON.parse(z.string().parse(recordedParams[0]?.[3])))
    expect(stored.sdkVersion).toBe(SDK_VERSION)
    expect(returned).toEqual(stored)
  })

  it('rejects an invalid publishAt before touching the database', async () => {
    let calls = 0
    const db: Queryable = {
      query(_text: string, _params: readonly QueryParam[]): Promise<QueryRows> {
        calls += 1
        return Promise.resolve({ rows: [], rowCount: 1 })
      },
    }
    const envelope = await createEnvelope(
      orderPlaced,
      { orderId: '018f0000-0000-7000-8000-000000000002' },
      {
        tenantId: null,
        source: 'shop-service',
      },
    )

    await expect(publishEnvelope(db, envelope, new Date('nonsense'))).rejects.toThrow(RangeError)
    expect(calls).toBe(0)
  })
})
