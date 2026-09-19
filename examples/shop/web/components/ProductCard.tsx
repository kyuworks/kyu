import { useState } from 'react'
import { MAX_LINE_QUANTITY, formatCents } from '../lib/cart'
import type { ShopProduct } from '../lib/shopDocuments'

export interface ProductCardProps {
  product: ShopProduct
  onAdd: (productId: string, quantity: number) => void
}

const MIN_QUANTITY = 1

function clampQuantity(value: number): number {
  if (Number.isNaN(value)) return MIN_QUANTITY
  return Math.min(MAX_LINE_QUANTITY, Math.max(MIN_QUANTITY, Math.trunc(value)))
}

/** One product: its name, its formatted price, a quantity stepper and an add button. */
export function ProductCard({ product, onAdd }: ProductCardProps) {
  // Held as text, not a number: clamping on every keystroke would stop a
  // person clearing the field to type a new value. Clamped on blur and on add.
  const [quantityText, setQuantityText] = useState(String(MIN_QUANTITY))

  function commitQuantity(): number {
    const clamped = clampQuantity(Number(quantityText))
    setQuantityText(String(clamped))
    return clamped
  }

  return (
    <div className="card product-card">
      <h3>{product.name}</h3>
      <p className="product-price">{formatCents(product.priceCents)}</p>
      <input
        type="number"
        aria-label={`Quantity of ${product.name}`}
        min={MIN_QUANTITY}
        max={MAX_LINE_QUANTITY}
        value={quantityText}
        onChange={(event) => setQuantityText(event.target.value)}
        onBlur={commitQuantity}
      />
      <button type="button" onClick={() => onAdd(product.id, commitQuantity())}>
        Add to order
      </button>
    </div>
  )
}
