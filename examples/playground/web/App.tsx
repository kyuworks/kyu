import { useEffect, useState } from 'react'
import { parseUiConfig } from './lib/uiConfig'
import { HomePage } from './pages/HomePage'

interface NavLink {
  href: string
  label: string
}

// One entry per page; a click is a full page load served by the SPA
// fallback in src/ui/serveWeb.ts's APP_ROUTES. No client-side router: for a
// five-page demo this is less code and it cannot desync from that list.
const NAV_LINKS: readonly NavLink[] = [
  { href: '/', label: 'Shop' },
  { href: '/bus', label: 'Bus' },
]

const DEFAULT_DASHBOARD_URL = 'http://localhost:8888'

function pageFor(pathname: string, dashboardUrl: string) {
  if (pathname === '/bus') return <p className="muted">The bus diagram lands in the next pull request.</p>
  return <HomePage dashboardUrl={dashboardUrl} />
}

export function App() {
  const [dashboardUrl, setDashboardUrl] = useState(DEFAULT_DASHBOARD_URL)
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
        {pageFor(pathname, dashboardUrl)}
      </main>
    </>
  )
}
