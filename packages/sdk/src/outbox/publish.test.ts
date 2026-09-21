import { defineEvent, envelopeSchema } from '@kyuworks/schemas'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Queryable, QueryParam, QueryRows } from '../db/queryable.js'
import { createPublisher } from './publish.js'

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
})
