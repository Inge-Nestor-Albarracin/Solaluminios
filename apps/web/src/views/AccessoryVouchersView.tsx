import { useState } from 'react'
import type { Page } from '../api/types'
import { Empty, Kpi, Loading, Notice, PageHeader, Pagination } from '../components/ui'
import { basketLabel, type Voucher } from '../lib/accessories'
import { formatDateTime } from '../lib/format'
import { useLoad } from '../lib/useLoad'
import type { Navigate } from './navigation'

const FILTERS = [
  { id: '', label: 'Todos' },
  { id: 'ENTRY', label: 'Ingresos' },
  { id: 'EXIT', label: 'Salidas sin venta' },
] as const

// Entries (IA-…) and exits without a sale (SS-…), newest first.
export function AccessoryVouchersView({ navigate }: { navigate: Navigate }) {
  const [kind, setKind] = useState<(typeof FILTERS)[number]['id']>('')
  const [page, setPage] = useState(1)
  const list = useLoad<Page<Voucher>>(`/accessories/vouchers?page=${page}&pageSize=20${kind ? `&kind=${kind}` : ''}`)

  return (
    <>
      <PageHeader
        eyebrow="Accesorios"
        title="Comprobantes"
        description="Cada ingreso y cada salida sin venta queda con su número, su soporte, quién lo hizo y el saldo de cada canasta. No se editan ni se borran."
        actions={
          <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'accessories' })}>
            Volver a canastas
          </button>
        }
      />
      <div className="tabs" role="tablist">
        {FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            role="tab"
            aria-selected={kind === filter.id}
            className={kind === filter.id ? 'tab active' : 'tab'}
            onClick={() => {
              setKind(filter.id)
              setPage(1)
            }}
          >
            {filter.label}
          </button>
        ))}
      </div>
      {list.error ? <Notice kind="error">{list.error}</Notice> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data && list.data.items.length === 0 ? <Empty title="Sin comprobantes">Todavía no hay comprobantes de este tipo.</Empty> : null}
      <ul className="doc-list">
        {(list.data?.items ?? []).map((voucher) => (
          <li key={voucher.id}>
            <button type="button" className="doc-row" onClick={() => navigate({ name: 'voucher', id: voucher.id })}>
              <span className="doc-main">
                <strong>
                  {voucher.number} · {voucher.kind === 'ENTRY' ? 'Ingreso' : voucher.exitTypeLabel}
                </strong>
                <small>
                  {voucher.kind === 'ENTRY' ? `${voucher.supplierName} · ${voucher.documentNumber}` : voucher.detail} · {voucher.createdBy.name}
                </small>
              </span>
              <span className="doc-side">
                <strong>
                  {voucher.kind === 'ENTRY' ? '+' : '−'}
                  {voucher.totals.units.toLocaleString('es-CO')} unid.
                </strong>
                <small>{formatDateTime(voucher.createdAt)}</small>
                <span className="badge">
                  {voucher.totals.baskets} {voucher.totals.baskets === 1 ? 'canasta' : 'canastas'}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {list.data && list.data.totalPages > 1 ? <Pagination page={list.data.page} totalPages={list.data.totalPages} total={list.data.total} onChange={setPage} /> : null}
    </>
  )
}

export function AccessoryVoucherView({ id, navigate }: { id: string; navigate: Navigate }) {
  const voucher = useLoad<Voucher>(`/accessories/vouchers/${encodeURIComponent(id)}`)
  const data = voucher.data
  const entry = data?.kind === 'ENTRY'

  return (
    <>
      <PageHeader
        eyebrow={entry ? 'Accesorios · Ingreso' : 'Accesorios · Salida sin venta'}
        title={data ? data.number : 'Comprobante'}
        description={data ? `${formatDateTime(data.createdAt)} · ${data.createdBy.name} · ${data.inventoryLocation.branch.name} · ${data.inventoryLocation.name}` : undefined}
        actions={
          <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'vouchers' })}>
            Ver comprobantes
          </button>
        }
      />
      {voucher.error ? <Notice kind="error">{voucher.error}</Notice> : null}
      {voucher.loading && !data ? <Loading /> : null}
      {data ? (
        <>
          <div className="kpis">
            {entry ? (
              <>
                <Kpi label="Proveedor" value={data.supplierName ?? ''} />
                <Kpi label="Factura o remisión" value={data.documentNumber ?? ''} hint={data.arrivalDate ? `Llegó el ${data.arrivalDate}` : 'Sin fecha de llegada'} />
              </>
            ) : (
              <>
                <Kpi label="Tipo" value={data.exitTypeLabel ?? ''} />
                <Kpi label="Detalle" value={data.detail ?? ''} hint={data.receivedBy ? `Recibió: ${data.receivedBy}` : undefined} />
              </>
            )}
            <Kpi label={entry ? 'Unidades que entraron' : 'Unidades que salieron'} value={data.totals.units.toLocaleString('es-CO')} dark />
          </div>
          {data.notes ? <Notice kind="info">Notas: {data.notes}</Notice> : null}
          {data.task ? (
            <p className="cell-sub">
              Aviso a {data.task.assignee.name}: {data.task.completedAt ? `visto el ${formatDateTime(data.task.completedAt)}` : 'pendiente de ver'}.
            </p>
          ) : null}
          <h2 className="subtitle">Canastas</h2>
          <ul className="doc-list">
            {data.movements.map((m) => (
              <li key={m.id}>
                <button type="button" className="doc-row" onClick={() => navigate({ name: 'basket', id: m.bundle.id })}>
                  <span className="doc-main">
                    <strong>{basketLabel(m.bundle)}</strong>
                    <small className="mono">{m.bundle.epc}</small>
                  </span>
                  <span className="doc-side">
                    <strong>
                      {m.type === 'ENTRY' ? '+' : '−'}
                      {m.quantity.toLocaleString('es-CO')}
                    </strong>
                    <small>
                      de {m.quantityBefore.toLocaleString('es-CO')} a {m.quantityAfter.toLocaleString('es-CO')}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  )
}
