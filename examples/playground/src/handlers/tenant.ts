import type { HandlerContext, MessageDataShape } from '@kinesin/sdk'
import { NonRetryableError } from '@kinesin/sdk'

// Every shop.* message is tenant-scoped (AGENTS.md non-goals); a null
// tenantId means a message this app never publishes reached the handler.
export function requireTenant<TData extends MessageDataShape>(handlerName: string, ctx: HandlerContext<TData>): string {
  const { tenantId } = ctx.envelope
  if (tenantId === null) throw new NonRetryableError(`${handlerName}: envelope ${ctx.envelope.id} has no tenantId`)
  return tenantId
}
