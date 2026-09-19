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
    <div className="card">
      <h1>Qtaxis shop: the bus</h1>
      <p>
        <a href="/">Back to the shop</a>
        {dashboardUrl !== '' && (
          <>
            {' '}
            &middot;{' '}
            <a href={dashboardUrl} target="_blank" rel="noreferrer">
              Hatchet dashboard
            </a>
          </>
        )}
      </p>
      <p className="status">{statusMessage}</p>
      {busDocument !== undefined && (
        <>
          <BusDiagram busDocument={busDocument} />
          <BusLegend engineWindowLimit={busDocument.counts.window.limit} />
        </>
      )}
    </div>
  )
}
