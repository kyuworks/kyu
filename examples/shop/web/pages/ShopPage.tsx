import { CartSummary } from '../components/CartSummary'
import type { CartSummaryLine } from '../components/CartSummary'
import { ProductCard } from '../components/ProductCard'
import type { CartAction, CartLine } from '../lib/cart'
import { cartTotalCents } from '../lib/cart'
import type { ShopProduct } from '../lib/shopDocuments'

export interface ShopPageProps {
  products: readonly ShopProduct[]
  statusMessage: string
  cartLines: readonly CartLine[]
  onCartAction: (action: CartAction) => void
}

// The catalogue rarely changes; only the cart lines a product still matches are shown.
function summaryLines(cartLines: readonly CartLine[], products: readonly ShopProduct[]): CartSummaryLine[] {
  const lines: CartSummaryLine[] = []
  for (const line of cartLines) {
    const product = products.find((candidate) => candidate.id === line.productId)
    if (product !== undefined) lines.push({ product, quantity: line.quantity })
  }
  return lines
}

/** Browse the catalogue, add to the cart, and see the running total before checkout. */
export function ShopPage({ products, statusMessage, cartLines, onCartAction }: ShopPageProps) {
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
      <CartSummary lines={summaryLines(cartLines, products)} totalCents={cartTotalCents(cartLines, products)}>
        <a href="/checkout">Go to checkout</a>
      </CartSummary>
    </div>
  )
}
