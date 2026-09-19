import { Card, CardContent, Link } from '@heroui/react'
import { BusDiagram } from '../components/BusDiagram'
import { BusLegend } from '../components/BusLegend'
import { useBusCounts } from '../lib/useBusCounts'

export interface BusPageProps {
  dashboardUrl: string
}

/** The #64 deliverable: every stage a message passes through, with the counts behind each one. */
export function BusPage({ dashboardUrl }: BusPageProps) {
  const { busDocument, statusMessage } = useBusCounts()

  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">Qtaxis shop: the bus</h1>
        <p>
          <Link href="/">Back to the shop</Link>
          {dashboardUrl !== '' && (
            <>
              {' '}
              &middot;{' '}
              <Link href={dashboardUrl} target="_blank" rel="noreferrer">
                Hatchet dashboard
              </Link>
            </>
          )}
        </p>
        <p aria-live="polite" className="empty:hidden font-mono text-sm text-danger">
          {statusMessage}
        </p>
        {busDocument !== undefined && (
          <>
            <BusDiagram busDocument={busDocument} />
            <BusLegend engineWindowLimit={busDocument.counts.window.limit} />
          </>
        )}
      </CardContent>
    </Card>
  )
}
