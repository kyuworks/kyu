import { useEffect, useState } from 'react'
import { describeFetchFailure } from './lib/fetchJson'
import { parseUiConfig } from './lib/uiConfig'
import { BusPage } from './pages/BusPage'
import { HomePage } from './pages/HomePage'

interface NavLink {
  href: string
  label: string
}

// One entry per page. Adding one here also means adding its path to
// src/ui/serveWeb.ts's APP_ROUTES — nothing ties the two lists together.
const NAV_LINKS: readonly NavLink[] = [
  { href: '/', label: 'Shop' },
  { href: '/bus', label: 'Bus' },
]

export function App() {
  // Empty until /ui.json answers: no dashboard link rather than a guessed one.
  const [dashboardUrl, setDashboardUrl] = useState('')
  const [statusMessage, setStatusMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/ui.json')
      .then((response) => response.text().then((bodyText) => ({ ok: response.ok, status: response.status, bodyText })))
      .then((outcome) => {
        if (cancelled) return
        if (!outcome.ok) {
          setStatusMessage(`ui.json failed: ${describeFetchFailure(outcome.status, outcome.bodyText)}`)
          return
        }
        const parsed = parseUiConfig(outcome.bodyText)
        if (parsed.ok) {
          setDashboardUrl(parsed.config.dashboardUrl)
        } else {
          setStatusMessage(`ui.json failed: ${parsed.error}`)
        }
      })
      .catch((error) => {
        if (!cancelled) setStatusMessage(`ui.json failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const pathname = window.location.pathname

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <p className="app-title">Qtaxis shop</p>
          <nav className="app-nav">
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} aria-current={pathname === link.href ? 'page' : undefined}>
                {link.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="app-main">
        <p className="status">{statusMessage}</p>
        {pathname === '/bus' ? <BusPage dashboardUrl={dashboardUrl} /> : <HomePage dashboardUrl={dashboardUrl} />}
      </main>
    </>
  )
}
