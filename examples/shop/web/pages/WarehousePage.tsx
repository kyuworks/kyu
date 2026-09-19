import { Card, CardContent, CardHeader, CardTitle, Link } from '@heroui/react'
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

// No re-sort: assumes its input is already newest first, the order
// GET /orders.json returns (ORDER BY o.id DESC).
/** The tenant's orders with no shipped_at yet, newest first, matching the Orders page. */
export function unshippedNewestFirst(orders: readonly ShopOrder[]): ShopOrder[] {
  return orders.filter((order) => order.stage !== 'shipped')
}

export interface WarehouseRowProps {
  order: ShopOrder
}

/** One unshipped order: its id, its lines in one line of text, the total, and the ship action. */
export function WarehouseRow({ order }: WarehouseRowProps) {
  return (
    <li>
      <Card>
        <CardHeader className="flex-row items-baseline justify-between gap-4">
          <CardTitle render={(props) => <h2 {...props} />}>
            Order <code>{shortOrderId(order.id)}</code>
          </CardTitle>
          <p className="text-sm text-muted">{formatCents(order.totalCents)}</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-muted">{summarizeLines(order.lines)}</p>
          <ShipForm orderId={order.id} />
        </CardContent>
      </Card>
    </li>
  )
}

export interface WarehouseListProps {
  orders: readonly ShopOrder[]
}

/** The unshipped orders, in the order given: WarehousePage passes them newest first. */
export function WarehouseList({ orders }: WarehouseListProps) {
  return (
    <ul className="m-0 mt-4 flex list-none flex-col gap-4 p-0" role="list">
      {orders.map((order) => (
        <WarehouseRow key={order.id} order={order} />
      ))}
    </ul>
  )
}

/** The orders with no shipped_at, newest first: the warehouse's own worklist. */
export function WarehousePage({ dashboardUrl }: WarehousePageProps) {
  const { orders, error } = useOrders()
  const unshipped = orders !== undefined ? unshippedNewestFirst(orders) : undefined

  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">Warehouse</h1>
        <p>
          <Link href="/orders">See all orders</Link>
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
        <p aria-live="polite" className="empty:hidden font-mono text-sm text-danger">
          {error ?? ''}
        </p>
        <p className="text-sm text-muted">Newest first.</p>
        {unshipped !== undefined && unshipped.length === 0 && <p className="text-muted">Nothing to ship.</p>}
        {unshipped !== undefined && unshipped.length > 0 && <WarehouseList orders={unshipped} />}
      </CardContent>
    </Card>
  )
}
