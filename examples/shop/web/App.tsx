import { useEffect, useState } from 'react'
import { parseUiConfig } from './lib/uiConfig'
import { HomePage } from './pages/HomePage'

interface NavLink {
  href: string
  label: string
}

// One entry per page; a click is a full page load, not a client-side
// route. Shop is served by the SPA fallback in src/ui/serveWeb.ts's
// APP_ROUTES; Bus still goes to the legacy busPage.ts HTML page — it is
// not in APP_ROUTES and not rendered by this app until a later pull
// request replaces it with React.
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
      .then((response) => response.text())
      .then((body) => {
        if (cancelled) return
        const outcome = parseUiConfig(body)
        if (outcome.ok) {
          setDashboardUrl(outcome.config.dashboardUrl)
        } else {
          setStatusMessage(`ui.json failed: ${outcome.error}`)
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
          <p className="app-title">Qtaxis playground</p>
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
        <HomePage dashboardUrl={dashboardUrl} />
      </main>
    </>
  )
}
