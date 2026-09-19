import { Chip } from '@heroui/react'
import { ShoppingBagIcon } from '@heroicons/react/24/outline'
import type { ReactNode } from 'react'

export interface NavLink {
  href: string
  label: string
}

// One entry per page. Adding one here also means adding its path to
// src/ui/serveWeb.ts's APP_ROUTES — nothing ties the two lists together.
export const NAV_LINKS: readonly NavLink[] = [
  { href: '/', label: 'Shop' },
  { href: '/checkout', label: 'Checkout' },
  { href: '/orders', label: 'Orders' },
  { href: '/warehouse', label: 'Warehouse' },
  { href: '/bus', label: 'Bus' },
]

export interface AppShellViewProps {
  pathname: string
  cartCount: number
  children: ReactNode
}

// Pure and presentational, like ShipFormView and ResendInvoiceActionView:
// App owns the fetch and cart state, this only renders what it is given.
export function AppShellView({ pathname, cartCount, children }: AppShellViewProps) {
  return (
    <>
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-4">
          <p className="m-0 flex items-center gap-2 text-lg font-semibold">
            <ShoppingBagIcon className="size-5" aria-hidden="true" />
            Qtaxis shop
          </p>
          <nav className="flex flex-1 items-center gap-4">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                aria-current={pathname === link.href ? 'page' : undefined}
                className="border-b-2 border-transparent py-1 text-muted no-underline aria-[current=page]:border-accent aria-[current=page]:text-foreground"
              >
                {link.label}
              </a>
            ))}
            {cartCount > 0 && (
              <Chip
                color="default"
                size="sm"
                role="status"
                aria-label={`${cartCount} item${cartCount === 1 ? '' : 's'} in your order`}
              >
                {cartCount}
              </Chip>
            )}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </>
  )
}
