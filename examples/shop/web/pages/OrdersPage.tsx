import { useEffect, useRef, useState } from 'react'
import { OrderTimeline } from '../components/OrderTimeline'
import { formatCents } from '../lib/cart'
import { readCustomerId } from '../lib/customer'
import { describeFetchFailure } from '../lib/fetchJson'
import type { ShopOrder } from '../lib/shopDocuments'
import { parseOrdersDocument } from '../lib/shopDocuments'

interface OrdersState {
  orders: ShopOrder[] | undefined
  error: string | undefined
}

interface OrdersFetchOutcome {
  ok: boolean
  status: number
  bodyText: string
}

const REFRESH_INTERVAL_MS = 5000
const EMPTY_STATE: OrdersState = { orders: undefined, error: undefined }

// A good body clears any previous error; a bad one keeps the last good list.
// Pure and unit-tested — a hook cannot run under renderToStaticMarkup.
export function nextOrdersState(previous: OrdersState, outcome: OrdersFetchOutcome): OrdersState {
  if (!outcome.ok) {
    return {
      orders: previous.orders,
      error: `orders.json failed: ${describeFetchFailure(outcome.status, outcome.bodyText)}`,
    }
  }
  const parsed = parseOrdersDocument(outcome.bodyText)
  if (parsed.ok) return { orders: parsed.orders, error: undefined }
  return { orders: previous.orders, error: `orders.json failed: ${parsed.error}` }
}

// Mirrors web/lib/useBusCounts.ts: each mount owns its own AbortController and in-flight guard.
function useOrders(): OrdersState {
  const [state, setState] = useState<OrdersState>(EMPTY_STATE)
  const fetching = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    fetching.current = false

    function refresh(): void {
      if (fetching.current) return
      fetching.current = true
      fetch('/orders.json', { signal: controller.signal })
        .then((response) =>
          response
            .text()
            .then((bodyText): OrdersFetchOutcome => ({ ok: response.ok, status: response.status, bodyText })),
        )
        .then((outcome) => {
          setState((previous) => nextOrdersState(previous, outcome))
        })
        .catch((error) => {
          if (controller.signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          setState((previous) => ({ orders: previous.orders, error: `orders.json failed: ${message}` }))
        })
        .finally(() => {
          fetching.current = false
        })
    }

    refresh()
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS)

    return () => {
      controller.abort()
      fetching.current = false
      clearInterval(interval)
    }
  }, [])

  return state
}

// Fixed locale, not the browser's: a test's expected string must not depend on the machine it runs on.
const ORDER_DATE_FORMAT = new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium', timeStyle: 'short' })

function shortOrderId(id: string): string {
  return id.slice(0, 8)
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
      <ul className="order-lines">
        {order.lines.map((line) => (
          <li key={line.productId} className="order-line">
            <span>
              {line.name} &times; {line.quantity}
            </span>
            <span>{formatCents(line.unitPriceCents * line.quantity)}</span>
          </li>
        ))}
      </ul>
      <p className="order-total">
        <span>Total</span>
        <span>{formatCents(order.totalCents)}</span>
      </p>
      <OrderTimeline stage={order.stage} />
    </li>
  )
}

export interface OrdersPageProps {
  dashboardUrl: string
}

/** Every order for the demo tenant, newest first, with its lines, total and the stage the bus moved it to. */
export function OrdersPage({ dashboardUrl }: OrdersPageProps) {
  const { orders, error } = useOrders()
  // Read once per mount: readCustomerId() is idempotent, but the badge must not flicker mid-session.
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
      <p className="status">{error ?? ''}</p>
      {orders !== undefined && orders.length === 0 && <p className="muted">No orders yet.</p>}
      {orders !== undefined && orders.length > 0 && (
        <ul className="order-list">
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} customerId={customerId} />
          ))}
        </ul>
      )}
    </div>
  )
}
