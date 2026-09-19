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
    <div className="order-resend-invoice">
      <button type="button" onClick={onSubmit} disabled={submitting || sent}>
        Resend invoice (simulated fault)
      </button>
      <p className="muted">
        Sends the invoice command for an id with no row, so the bus page has a dead letter to show.
      </p>
      <p className={sent ? 'status status-ok' : 'status'} aria-live="polite">
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
    <li className="card order-card">
      <div className="order-card-header">
        <h2>
          Order <code>{shortOrderId(order.id)}</code>
          {order.customerId === customerId && <span className="order-yours">yours</span>}
        </h2>
        {order.paidAt !== null && <p className="muted">{ORDER_DATE_FORMAT.format(new Date(order.paidAt))}</p>}
      </div>
      <ul className="order-lines" role="list">
        {order.lines.map((line) => (
          <li key={line.productId} className="order-line">
            <span>
              {line.name} &times; {line.quantity}
            </span>
            <span>
              {formatCents(line.unitPriceCents)} each &middot; {formatCents(line.unitPriceCents * line.quantity)}
            </span>
          </li>
        ))}
      </ul>
      <p className="order-total">
        <span>Total</span>
        <span>{formatCents(order.totalCents)}</span>
      </p>
      <OrderTimeline stage={order.stage} />
      <ResendInvoiceAction orderId={order.id} />
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
    <ul className="order-list" role="list">
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
    <div className="card">
      <h1>Orders</h1>
      <p>
        <a href="/">Back to the shop</a>
        {dashboardUrl !== '' && (
          <>
            {' '}
            &middot;{' '}
            <a href={dashboardUrl} target="_blank" rel="noreferrer">
              Hatchet dashboard
            </a>
          </>
        )}
      </p>
      {limit !== undefined && <p className="muted">Showing the newest {limit} orders.</p>}
      <p className="status" aria-live="polite">
        {error ?? ''}
      </p>
      {orders !== undefined && orders.length === 0 && <p className="muted">No orders yet.</p>}
      {orders !== undefined && orders.length > 0 && <OrderList orders={orders} customerId={customerId} />}
    </div>
  )
}
