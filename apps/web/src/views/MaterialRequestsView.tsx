import { useState } from 'react'
import type { Page } from '../api/types'
import { Empty, Loading, Notice, PageHeader, Pagination } from '../components/ui'
import { formatDateTime } from '../lib/format'
import { REQUEST_STATUS_LABEL, type MaterialRequestRow } from '../lib/materialRequests'
import { useLoad } from '../lib/useLoad'
import { canSell, useSession } from '../session/session-context'
import type { Navigate } from './navigation'

const FILTERS = [
  { id: 'OPEN', label: 'Por preparar' },
  { id: 'SHIPPED', label: 'En camino' },
  { id: 'RECEIVED', label: 'Recibidas' },
  { id: 'CANCELLED', label: 'Canceladas' },
] as const

// Material requests visible to the user: Sales its own; warehouse staff those
// they prepare or receive and those of their location; ADMIN all.
export function MaterialRequestsView({ navigate }: { navigate: Navigate }) {
  const { user } = useSession()
  const [status, setStatus] = useState<(typeof FILTERS)[number]['id']>('OPEN')
  const [page, setPage] = useState(1)
  const list = useLoad<Page<MaterialRequestRow>>(`/material-requests?status=${status}&page=${page}&pageSize=20`)

  return (
    <>
      <PageHeader
        eyebrow="Abastecimiento"
        title="Solicitudes de materiales"
        description="Ventas pide perfiles a bodega para un almacén, sin leer chips. Bodega los prepara por paquetes completos, confirma la salida y el almacén marca el pedido como recibido."
        actions={
          canSell(user?.role) ? (
            <button type="button" className="button" onClick={() => navigate({ name: 'request' })}>
              Nueva solicitud
            </button>
          ) : undefined
        }
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
      {list.data && list.data.items.length === 0 ? <Empty title="Sin solicitudes">No hay solicitudes en este estado.</Empty> : null}
      <ul className="doc-list">
        {(list.data?.items ?? []).map((item) => (
          <li key={item.id}>
            <button type="button" className="doc-row" onClick={() => navigate({ name: 'request', id: item.id })}>
              <span className="doc-main">
                <strong>{item.number}</strong>
                <small>
                  {item.source.name} → {item.destination.name} · {item.lineCount} {item.lineCount === 1 ? 'renglón' : 'renglones'} · prepara {item.assignee.name}
                  {item.createdBy.id !== user?.id ? ` · pidió ${item.createdBy.name}` : ''}
                </small>
              </span>
              <span className="doc-side">
                <strong>
                  {item.prepared.toLocaleString('es-CO')} / {item.requested.toLocaleString('es-CO')} perf.
                </strong>
                <small>{formatDateTime(item.dueAt)}</small>
                <span className="badge">{REQUEST_STATUS_LABEL[item.status]}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {list.data && list.data.totalPages > 1 ? (
        <Pagination page={list.data.page} totalPages={list.data.totalPages} total={list.data.total} onChange={setPage} />
      ) : null}
    </>
  )
}
