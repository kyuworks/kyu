import { Button, Card, CardContent, CardHeader, CardTitle, NumberField, NumberFieldInput } from '@heroui/react'
import { PlusIcon } from '@heroicons/react/24/outline'
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
  // Text, not a number: clamping every keystroke would stop clearing the field to retype it.
  const [quantityText, setQuantityText] = useState(String(MIN_QUANTITY))

  function commitQuantity(): number {
    const clamped = clampQuantity(Number(quantityText))
    setQuantityText(String(clamped))
    return clamped
  }

  return (
    <Card className="flex flex-col gap-2">
      <CardHeader>
        <CardTitle>{product.name}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-muted">{formatCents(product.priceCents)}</p>
        <NumberField
          aria-label={`Quantity of ${product.name}`}
          minValue={MIN_QUANTITY}
          maxValue={MAX_LINE_QUANTITY}
          value={Number(quantityText)}
          onChange={(value) => setQuantityText(String(value))}
        >
          <NumberFieldInput />
        </NumberField>
        <Button variant="primary" size="sm" onPress={() => onAdd(product.id, commitQuantity())}>
          Add to order
          <PlusIcon className="size-4" aria-hidden="true" />
        </Button>
      </CardContent>
    </Card>
  )
}
