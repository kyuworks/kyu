import { useState } from 'react'
import { OrderTimeline } from '../components/OrderTimeline'
import { formatCents } from '../lib/cart'
import { readCustomerId } from '../lib/customer'
import type { ShopOrder } from '../lib/shopDocuments'
import { useOrders } from '../lib/useOrders'

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
