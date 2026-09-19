export interface HomePageProps {
  dashboardUrl: string
}

/** What the demo is, until the shop pages land and this becomes the Shop page. */
export function HomePage({ dashboardUrl }: HomePageProps) {
  return (
    <div className="card">
      <h1>Qtaxis playground</h1>
      <p>
        A small app that uses <code>@qtaxis/sdk</code> the way a real project would. See what happens on the{' '}
        <a href="/bus">bus diagram</a>
        {dashboardUrl !== '' && (
          <>
            {' '}
            or the{' '}
            <a href={dashboardUrl} target="_blank" rel="noreferrer">
              Hatchet dashboard
            </a>
          </>
        )}
        .
      </p>
      <p className="muted">
        The shop pages are not built yet. Publish a message from the terminal instead:
        <br />
        <code>pnpm --filter @qtaxis/playground publish-cli place-order --tenant &lt;uuid&gt;</code>
      </p>
    </div>
  )
}
