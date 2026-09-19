import { Button, Card, CardContent, CardHeader, CardTitle, Chip, Link, Separator } from '@heroui/react'
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { useReducer, useState } from 'react'
import { OrderTimeline } from '../components/OrderTimeline'
import { formatCents } from '../lib/cart'
import { readCustomerId } from '../lib/customer'
import { describeSubmitFailure, postJsonOutcome } from '../lib/fetchJson'
import { RESEND_INVOICE_PATH, buildResendInvoiceBody } from '../lib/resendInvoice'
import type { ShopOrder } from '../lib/shopDocuments'
import { shortOrderId } from '../lib/shopDocuments'
import type { SubmitPhase } from '../lib/submitPhase'
import { canSubmit, nextSubmitPhase } from '../lib/submitPhase'
import { useOrders } from '../lib/useOrders'

// Fixed locale, not the browser's: a test's expected string must not depend on the machine it runs on.
const ORDER_DATE_FORMAT = new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium', timeStyle: 'short' })

export interface ResendInvoiceActionViewProps {
  phase: SubmitPhase
  onSubmit: () => void
}

// Pure and presentational: a real submit can't run under renderToStaticMarkup
// (it drops effects), so tests render this directly with a fixed phase.
export function ResendInvoiceActionView({ phase, onSubmit }: ResendInvoiceActionViewProps) {
  const submitting = phase.kind === 'submitting'
  const sent = phase.kind === 'done'

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-4">
      <Button variant="secondary" size="sm" isDisabled={submitting || sent} onPress={onSubmit}>
        Resend invoice (simulated fault)
        <ArrowPathIcon className="size-4" aria-hidden="true" />
      </Button>
      <p className="text-sm text-muted">
        Sends the invoice command for an id with no row, so the bus page has a dead letter to show.
      </p>
      <p
        data-tone={sent ? 'ok' : 'error'}
        aria-live="polite"
        className="mt-2 font-mono text-sm data-[tone=ok]:text-success data-[tone=error]:text-danger"
      >
        {sent ? 'Sent, check the bus page for the failed run.' : phase.kind === 'failed' ? phase.error : ''}
      </p>
    </div>
  )
}

export interface ResendInvoiceActionProps {
  orderId: string
}

// The simulated fault: no invoice id means the server sends the command for
// one with no shop_invoice row, so handleSendInvoice throws and the run
// becomes the dead letter the Bus page's send-invoice column shows.
/** A small action that gives the Bus page a dead letter to show. */
export function ResendInvoiceAction({ orderId }: ResendInvoiceActionProps) {
  const [phase, dispatch] = useReducer(nextSubmitPhase, { kind: 'idle' })

  function resend(): void {
    if (!canSubmit(phase)) return
    dispatch({ kind: 'submit' })
    void postJsonOutcome(RESEND_INVOICE_PATH, buildResendInvoiceBody(orderId))
      .then((outcome) => {
        if (outcome.ok) {
          dispatch({ kind: 'succeeded' })
        } else {
          dispatch({ kind: 'failed', error: describeSubmitFailure('resend invoice', outcome) })
        }
      })
      .catch((error) => {
        dispatch({
          kind: 'failed',
          error: `resend invoice failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      })
  }

  return <ResendInvoiceActionView phase={phase} onSubmit={resend} />
}

export interface OrderCardProps {
  order: ShopOrder
  customerId: string
}

/** One order: its id, lines, total and stage timeline; a "yours" badge for the browser's own orders. */
export function OrderCard({ order, customerId }: OrderCardProps) {
  return (
    <li>
      <Card>
        <CardHeader className="flex-row items-baseline justify-between gap-4">
          <CardTitle render={(props) => <h2 {...props} />}>
            Order <code>{shortOrderId(order.id)}</code>
            {order.customerId === customerId && (
              <Chip color="default" size="sm" className="ml-2">
                yours
              </Chip>
            )}
          </CardTitle>
          {order.paidAt !== null && (
            <p className="text-sm text-muted">{ORDER_DATE_FORMAT.format(new Date(order.paidAt))}</p>
          )}
        </CardHeader>
        <CardContent>
          <ul className="m-0 list-none p-0" role="list">
            {order.lines.map((line) => (
              <li key={line.productId} className="flex items-center justify-between gap-4 border-b border-border py-2">
                <span>
                  {line.name} &times; {line.quantity}
                </span>
                <span>
                  {formatCents(line.unitPriceCents)} each &middot; {formatCents(line.unitPriceCents * line.quantity)}
                </span>
              </li>
            ))}
          </ul>
          <Separator className="my-3" />
          <p className="flex justify-between font-semibold">
            <span>Total</span>
            <span>{formatCents(order.totalCents)}</span>
          </p>
          <OrderTimeline stage={order.stage} />
          <ResendInvoiceAction orderId={order.id} />
        </CardContent>
      </Card>
    </li>
  )
}

export interface OrderListProps {
  orders: readonly ShopOrder[]
  customerId: string
}

// Extracted so a test can render it directly with data: OrdersPage's own
// fetch hook never resolves under renderToStaticMarkup, so this element
// would otherwise never appear in a static render.
/** The order cards, newest first. */
export function OrderList({ orders, customerId }: OrderListProps) {
  return (
    <ul className="m-0 mt-4 flex list-none flex-col gap-4 p-0" role="list">
      {orders.map((order) => (
        <OrderCard key={order.id} order={order} customerId={customerId} />
      ))}
    </ul>
  )
}

export interface OrdersPageProps {
  dashboardUrl: string
}

/** The newest `limit` orders for the demo tenant, newest first, with their lines, total and stage. */
export function OrdersPage({ dashboardUrl }: OrdersPageProps) {
  const { orders, limit, error } = useOrders()
  // Read once per mount, not on every render: if storage throws,
  // readCustomerId() mints a fresh random id each call, and re-reading it
  // would make the "yours" badge flicker between different ids.
  const [customerId] = useState(() => readCustomerId())

  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <h1>Orders</h1>
        <p>
          <Link href="/">Back to the shop</Link>
          {dashboardUrl !== '' && (
            <>
              {' '}
              &middot;{' '}
              <Link href={dashboardUrl} target="_blank" rel="noreferrer">
                Hatchet dashboard
              </Link>
            </>
          )}
        </p>
        {limit !== undefined && <p className="text-sm text-muted">Showing the newest {limit} orders.</p>}
        <p aria-live="polite" className="font-mono text-sm text-danger">
          {error ?? ''}
        </p>
        {orders !== undefined && orders.length === 0 && <p className="text-muted">No orders yet.</p>}
        {orders !== undefined && orders.length > 0 && <OrderList orders={orders} customerId={customerId} />}
      </CardContent>
    </Card>
  )
}
