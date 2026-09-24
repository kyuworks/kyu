import { z } from 'zod'
import type { RelayQueryable } from '../db/queryable.js'
import { KyuError } from '../hatchet.js'

const tenantIdSchema = z.uuid()
const pausedRowSchema = z.object({ paused: z.boolean() })

/** Pause holds a business tenant's new messages in the outbox; `db` is the caller's own pool or transaction. */
export interface KyuTenants {
  /** The relay stops shipping this tenant's messages from its next claim; runs already in the engine carry on. Safe to repeat. */
  pause(db: RelayQueryable, tenantId: string): Promise<void>
  /** The relay ships the held messages on its next tick, in publish order. Safe to repeat. */
  resume(db: RelayQueryable, tenantId: string): Promise<void>
  isPaused(db: RelayQueryable, tenantId: string): Promise<boolean>
}

export function parseTenantId(caller: string, tenantId: string): string {
  const parsed = tenantIdSchema.safeParse(tenantId)
  if (!parsed.success) throw new KyuError(`${caller}: "${tenantId}" is not a uuid tenant id`)
  return parsed.data
}

export async function pauseTenant(db: RelayQueryable, tenantId: string): Promise<void> {
  const id = parseTenantId('tenants.pause', tenantId)
  await db.query('INSERT INTO kyu_paused_tenant (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [id])
}

export async function resumeTenant(db: RelayQueryable, tenantId: string): Promise<void> {
  const id = parseTenantId('tenants.resume', tenantId)
  await db.query('DELETE FROM kyu_paused_tenant WHERE tenant_id = $1', [id])
}

export async function isTenantPaused(db: RelayQueryable, tenantId: string): Promise<boolean> {
  const id = parseTenantId('tenants.isPaused', tenantId)
  const result = await db.query('SELECT EXISTS (SELECT 1 FROM kyu_paused_tenant WHERE tenant_id = $1) AS paused', [id])
  const parsed = pausedRowSchema.safeParse(result.rows[0])
  if (!parsed.success)
    throw new KyuError('tenants.isPaused: malformed row from kyu_paused_tenant', { cause: parsed.error })
  return parsed.data.paused
}
