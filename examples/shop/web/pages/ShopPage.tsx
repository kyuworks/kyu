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
    <div className="shop-layout">
      <div>
        <h1>Qtaxis shop</h1>
        <p className="status">{statusMessage}</p>
        <div className="product-grid">
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
        <a href="/checkout">Go to checkout</a>
      </CartSummary>
    </div>
  )
}
