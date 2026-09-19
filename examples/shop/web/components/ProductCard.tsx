import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  NumberField,
  NumberFieldDecrementButton,
  NumberFieldGroup,
  NumberFieldIncrementButton,
  NumberFieldInput,
} from '@heroui/react'
import { MinusIcon, PlusIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { MAX_LINE_QUANTITY, MIN_LINE_QUANTITY, clampQuantity, formatCents } from '../lib/cart'
import type { ShopProduct } from '../lib/shopDocuments'

export interface ProductCardProps {
  product: ShopProduct
  onAdd: (productId: string, quantity: number) => void
}

/** One product: its name, its formatted price, a quantity stepper and an add button. */
export function ProductCard({ product, onAdd }: ProductCardProps) {
  const [quantity, setQuantity] = useState(MIN_LINE_QUANTITY)

  return (
    <Card className="flex flex-col gap-2">
      <CardHeader>
        <CardTitle>{product.name}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-muted">{formatCents(product.priceCents)}</p>
        <NumberField
          aria-label={`Quantity of ${product.name}`}
          minValue={MIN_LINE_QUANTITY}
          maxValue={MAX_LINE_QUANTITY}
          value={quantity}
          onChange={(value) => setQuantity(clampQuantity(value))}
        >
          <NumberFieldGroup>
            <NumberFieldDecrementButton aria-label={`Decrease quantity of ${product.name}`}>
              <MinusIcon className="size-4" aria-hidden="true" />
            </NumberFieldDecrementButton>
            <NumberFieldInput />
            <NumberFieldIncrementButton aria-label={`Increase quantity of ${product.name}`}>
              <PlusIcon className="size-4" aria-hidden="true" />
            </NumberFieldIncrementButton>
          </NumberFieldGroup>
        </NumberField>
        <Button variant="primary" size="sm" onPress={() => onAdd(product.id, quantity)}>
          Add to order
          <PlusIcon className="size-4" aria-hidden="true" />
        </Button>
      </CardContent>
    </Card>
  )
}
