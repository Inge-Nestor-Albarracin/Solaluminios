import { formatPercent } from '../lib/commerce'
import { formatDateTime } from '../lib/format'
import type { RequestUpdate, RequestUpdates } from '../lib/requestUpdates'

// «Respuestas a tus solicitudes»: what the administrator answered to the
// seller's global discount and manual price requests. Each notice stays until
// the seller opens its quote.
export function RequestUpdatesNotice({ updates, onOpen }: { updates: RequestUpdates | null; onOpen: (quoteId: string) => void }) {
  if (!updates || updates.count === 0) return null
  return (
    <section className="request-updates" aria-label="Respuestas a tus solicitudes">
      <h2 className="subtitle">
        {updates.count === 1 ? 'Tienes 1 respuesta nueva a tus solicitudes' : `Tienes ${updates.count} respuestas nuevas a tus solicitudes`}
      </h2>
      <ul>
        {updates.items.map((item) => (
          <li key={item.id} className={item.status === 'APPROVED' ? 'approved' : 'rejected'}>
            <span>
              <span>
                <strong>{item.quote.number}</strong> · {item.quote.customerName}
              </span>
              <span className="request-update-text">{describe(item)}</span>
              {item.resolvedAt ? <small>{formatDateTime(item.resolvedAt)}</small> : null}
            </span>
            <button type="button" className="button button-secondary" onClick={() => onOpen(item.quote.id)}>
              Ver cotización
            </button>
          </li>
        ))}
      </ul>
      {updates.count > updates.items.length ? <p className="cell-sub">Se muestran las {updates.items.length} más recientes.</p> : null}
    </section>
  )
}

function describe(item: RequestUpdate): string {
  const what = item.kind === 'GLOBAL_DISCOUNT' ? `Descuento global de ${formatPercent(item.requestedPercent ?? '0')}` : 'Precio manual'
  if (item.status === 'APPROVED') {
    const next = item.kind === 'GLOBAL_DISCOUNT' ? 'ya quedó aplicado' : 'revisa el precio aprobado en la cotización'
    return `${what} aprobado por ${item.approver.name}: ${next}.`
  }
  return `${what} rechazado por ${item.approver.name}${item.resolution ? `: «${item.resolution}»` : ''}.`
}
