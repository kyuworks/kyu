import { Alert, AlertContent, AlertIndicator, AlertTitle, Link } from '@heroui/react'
import { CartSummary } from '../components/CartSummary'
import { ProductCard } from '../components/ProductCard'
import type { CartAction, CartLine } from '../lib/cart'
import { cartSummary } from '../lib/cart'
import type { ShopProduct } from '../lib/shopDocuments'

export interface ShopPageProps {
  products: readonly ShopProduct[]
  statusMessage: string
  cartLines: readonly CartLine[]
  onCartAction: (action: CartAction) => void
}

/** Browse the catalogue, add to the cart, and see the running total before checkout. */
export function ShopPage({ products, statusMessage, cartLines, onCartAction }: ShopPageProps) {
  const summary = cartSummary(cartLines, products)

  return (
    <div className="grid gap-6 items-start md:grid-cols-[1fr_18rem]">
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold">Kyu shop</h1>
        {statusMessage !== '' && (
          <Alert status="danger" role="alert">
            <AlertIndicator />
            <AlertContent>
              <AlertTitle>{statusMessage}</AlertTitle>
            </AlertContent>
          </Alert>
        )}
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(12rem,1fr))]">
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              onAdd={(productId, quantity) => onCartAction({ kind: 'add', productId, quantity })}
            />
          ))}
        </div>
      </div>
      <CartSummary
        lines={summary.lines}
        totalCents={summary.totalCents}
        onRemove={(productId) => onCartAction({ kind: 'set', productId, quantity: 0 })}
      >
        <Link href="/checkout">Go to checkout</Link>
      </CartSummary>
    </div>
  )
}
