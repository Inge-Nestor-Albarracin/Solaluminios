import { Empty, Kpi, Loading, Notice, PageHeader } from '../components/ui'
import { MOVEMENT_LABEL, ORIGIN_LABEL, basketLabel, type BasketDetail } from '../lib/accessories'
import { formatDateTime } from '../lib/format'
import { useLoad } from '../lib/useLoad'
import type { Navigate } from './navigation'

// One basket and its history (kárdex): every unit that came in or went out,
// with its voucher, who did it and the balance before and after.
export function BasketView({ id, navigate }: { id: string; navigate: Navigate }) {
  const basket = useLoad<BasketDetail>(`/accessories/baskets/${encodeURIComponent(id)}`)
  const data = basket.data

  return (
    <>
      <PageHeader
        eyebrow="Accesorios · Canasta"
        title={data ? basketLabel(data) : 'Canasta'}
        description={data ? `Chip ${data.epc}${data.reference.brand ? ` · ${data.reference.brand}` : ''}` : undefined}
        actions={
          <>
            <button type="button" className="button" onClick={() => navigate({ name: 'voucherNew', kind: 'ENTRY' })}>
              Ingreso
            </button>
            <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'voucherNew', kind: 'EXIT' })}>
              Salida sin venta
            </button>
            <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'accessories' })}>
              Volver a canastas
            </button>
          </>
        }
      />
      {basket.error ? <Notice kind="error">{basket.error}</Notice> : null}
      {basket.loading && !data ? <Loading /> : null}
      {data ? (
        <>
          <div className="kpis">
            <Kpi label="Unidades hoy" value={data.quantity.toLocaleString('es-CO')} dark />
            <Kpi label="Disponibles" value={data.available.toLocaleString('es-CO')} hint={data.reserved > 0 ? `${data.reserved} reservadas para ventas` : 'Nada reservado'} />
            <Kpi label="Origen" value={data.origin ? ORIGIN_LABEL[data.origin] : 'Sin origen'} />
            <Kpi label="Bodega" value={data.inventoryLocation.name} hint={data.inventoryLocation.branch.name} />
          </div>

          <h2 className="subtitle">Historial</h2>
          {data.movements.length === 0 ? (
            <Empty title="Sin movimientos">La canasta se registró vacía: su historial empieza con el primer ingreso.</Empty>
          ) : null}
          <ul className="doc-list">
            {data.movements.map((m) => {
              const incoming = m.type === 'INITIAL_STOCK' || m.type === 'ENTRY' || m.type === 'ADJUSTMENT_IN'
              const content = (
                <>
                  <span className="doc-main">
                    <strong>
                      {MOVEMENT_LABEL[m.type]}
                      {m.accessoryVoucher ? ` ${m.accessoryVoucher.number}` : ''}
                    </strong>
                    <small>
                      {formatDateTime(m.occurredAt)} · {m.performedBy.name}
                      {m.reason && !m.accessoryVoucher ? ` · ${m.reason}` : ''}
                    </small>
                  </span>
                  <span className="doc-side">
                    <strong>
                      {incoming ? '+' : '−'}
                      {m.quantity.toLocaleString('es-CO')}
                    </strong>
                    <small>
                      de {m.quantityBefore.toLocaleString('es-CO')} a {m.quantityAfter.toLocaleString('es-CO')}
                    </small>
                  </span>
                </>
              )
              return (
                <li key={m.id}>
                  {m.accessoryVoucher ? (
                    <button type="button" className="doc-row" onClick={() => navigate({ name: 'voucher', id: m.accessoryVoucher!.id })}>
                      {content}
                    </button>
                  ) : (
                    <div className="doc-row">{content}</div>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      ) : null}
    </>
  )
}
