import { formatCents } from '../lib/cart'
import type { ShopOrder, ShopOrderLine } from '../lib/shopDocuments'
import { shortOrderId } from '../lib/shopDocuments'
import { useOrders } from '../lib/useOrders'
import { ShipForm } from '../components/ShipForm'

export interface WarehousePageProps {
  dashboardUrl: string
}

function summarizeLine(line: ShopOrderLine): string {
  return `${line.name} × ${line.quantity}`
}

function summarizeLines(lines: readonly ShopOrderLine[]): string {
  return lines.map(summarizeLine).join(', ')
}

// Reverses rather than re-sorting: assumes its input is already newest
// first, the order GET /orders.json returns (ORDER BY o.id DESC).
/** The tenant's orders with no shipped_at yet, oldest first: a worklist, not a shop view. */
export function unshippedOldestFirst(orders: readonly ShopOrder[]): ShopOrder[] {
  return orders.filter((order) => order.stage !== 'shipped').reverse()
}

export interface WarehouseRowProps {
  order: ShopOrder
}

/** One unshipped order: its id, its lines in one line of text, the total, and the ship action. */
export function WarehouseRow({ order }: WarehouseRowProps) {
  return (
    <li className="card warehouse-row">
      <div className="warehouse-row-header">
        <h2>
          Order <code>{shortOrderId(order.id)}</code>
        </h2>
        <p className="order-total">{formatCents(order.totalCents)}</p>
      </div>
      <p className="muted">{summarizeLines(order.lines)}</p>
      <ShipForm orderId={order.id} />
    </li>
  )
}

export interface WarehouseListProps {
  orders: readonly ShopOrder[]
}

/** The unshipped orders, oldest first. */
export function WarehouseList({ orders }: WarehouseListProps) {
  return (
    <ul className="warehouse-list" role="list">
      {orders.map((order) => (
        <WarehouseRow key={order.id} order={order} />
      ))}
    </ul>
  )
}

/** The orders with no shipped_at, oldest first: the warehouse's own worklist. */
export function WarehousePage({ dashboardUrl }: WarehousePageProps) {
  const { orders, error } = useOrders()
  const unshipped = orders !== undefined ? unshippedOldestFirst(orders) : undefined

  return (
    <div className="card">
      <h1>Warehouse</h1>
      <p>
        <a href="/orders">See all orders</a>
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
      <p className="status" aria-live="polite">
        {error ?? ''}
      </p>
      {unshipped !== undefined && unshipped.length === 0 && <p className="muted">Nothing to ship.</p>}
      {unshipped !== undefined && unshipped.length > 0 && <WarehouseList orders={unshipped} />}
    </div>
  )
}
