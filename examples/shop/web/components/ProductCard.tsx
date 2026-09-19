import { useState } from 'react'
import { formatCents } from '../lib/cart'
import type { ShopProduct } from '../lib/shopDocuments'

export interface ProductCardProps {
  product: ShopProduct
  onAdd: (productId: string, quantity: number) => void
}

// Mirrors the server's own line schema (src/ui/requests.ts): 1 to 99.
const MIN_QUANTITY = 1
const MAX_QUANTITY = 99

function clampQuantity(value: number): number {
  if (Number.isNaN(value)) return MIN_QUANTITY
  return Math.min(MAX_QUANTITY, Math.max(MIN_QUANTITY, Math.trunc(value)))
}

/** One product: its name, its formatted price, a quantity stepper and an add button. */
export function ProductCard({ product, onAdd }: ProductCardProps) {
  const [quantity, setQuantity] = useState(MIN_QUANTITY)

  return (
    <div className="card product-card">
      <h3>{product.name}</h3>
      <p className="product-price">{formatCents(product.priceCents)}</p>
      <input
        type="number"
        aria-label={`Quantity of ${product.name}`}
        min={MIN_QUANTITY}
        max={MAX_QUANTITY}
        value={quantity}
        onChange={(event) => setQuantity(clampQuantity(event.target.valueAsNumber))}
      />
      <button type="button" onClick={() => onAdd(product.id, quantity)}>
        Add to order
      </button>
    </div>
  )
}
