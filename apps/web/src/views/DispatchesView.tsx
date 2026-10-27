import { useState } from 'react'
import type { Page } from '../api/types'
import { Empty, Loading, Notice, PageHeader, Pagination } from '../components/ui'
import { DISPATCH_STATUS_LABEL, type DispatchListItem } from '../lib/commerce'
import { formatDateTime } from '../lib/format'
import { useLoad } from '../lib/useLoad'
import { useNow } from '../lib/useNow'
import type { Navigate } from './navigation'

const FILTERS = [
  { id: 'OPEN', label: 'Abiertos' },
  { id: 'CONFIRMED', label: 'Confirmados' },
  { id: 'CANCELLED', label: 'Cancelados' },
] as const

// Dispatches visible to the user: warehouse staff see those of their
// location or assigned to them; sales those of their orders; ADMIN all.
export function DispatchesView({ navigate }: { navigate: Navigate }) {
  const [status, setStatus] = useState<(typeof FILTERS)[number]['id']>('OPEN')
  const [page, setPage] = useState(1)
  const list = useLoad<Page<DispatchListItem>>(`/dispatches?status=${status}&page=${page}&pageSize=20`)
  const now = useNow(60_000)

  return (
    <>
      <PageHeader
        eyebrow="Bodega"
        title="Despachos"
        description="Entregas autorizadas de órdenes de venta. Ábrelas para leer los paquetes y confirmar la salida."
      />
      <div className="tabs" role="tablist">
        {FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            role="tab"
            aria-selected={status === filter.id}
            className={status === filter.id ? 'tab active' : 'tab'}
            onClick={() => {
              setStatus(filter.id)
              setPage(1)
            }}
          >
            {filter.label}
          </button>
        ))}
      </div>
      {list.error ? <Notice kind="error">{list.error}</Notice> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data && list.data.items.length === 0 ? <Empty title="Sin despachos">No hay despachos en este estado.</Empty> : null}
      <ul className="doc-list">
        {(list.data?.items ?? []).map((item) => {
          const overdue = item.status === 'OPEN' && new Date(item.dueAt).getTime() < now
          return (
            <li key={item.id}>
              <button type="button" className="doc-row" onClick={() => navigate({ name: 'dispatch', id: item.id })}>
                <span className="doc-main">
                  <strong>{item.number}{item.partial ? ' · parcial' : ''}</strong>
                  <small>
                    Orden {item.salesOrder.number} · {item.salesOrder.customerName} · {item.inventoryLocation.name} · {item.assignee.name}
                  </small>
                </span>
                <span className="doc-side">
                  <small>{formatDateTime(item.dueAt)}</small>
                  {overdue ? <span className="badge badge-warning">Atrasado</span> : null}
                  {item._count.incidents > 0 ? <span className="badge badge-warning">{item._count.incidents} incidencias</span> : null}
                  <span className="badge">{DISPATCH_STATUS_LABEL[item.status]}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {list.data && list.data.totalPages > 1 ? (
        <Pagination page={list.data.page} totalPages={list.data.totalPages} total={list.data.total} onChange={setPage} />
      ) : null}
    </>
  )
}
