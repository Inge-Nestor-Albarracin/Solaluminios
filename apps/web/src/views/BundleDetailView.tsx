import { useCallback, useState } from 'react'
import type { BundleDetail, Movement, Page } from '../api/types'
import { OperationsPanel } from '../components/OperationsPanel'
import { Empty, Loading, Notice, PageHeader, Pagination } from '../components/ui'
import {
  MOVEMENT_LABELS,
  bundlePlace,
  finishLabel,
  formatArrival,
  formatDateTime,
  movementPlaces,
  referenceLabel,
} from '../lib/format'
import { useLoad } from '../lib/useLoad'
import type { Navigate } from './navigation'

const HISTORY_PAGE_SIZE = 10

export function BundleDetailView({ id, navigate }: { id: string; navigate: Navigate }) {
  const enc = encodeURIComponent(id)
  const bundle = useLoad<BundleDetail>(`/inventory/bundles/${enc}`)
  const [page, setPage] = useState(1)
  const history = useLoad<Page<Movement>>(
    `/inventory/bundles/${enc}/movements?page=${page}&pageSize=${HISTORY_PAGE_SIZE}`,
  )
  const [message, setMessage] = useState<string | null>(null)

  const { reload: reloadBundle } = bundle
  const { reload: reloadHistory } = history
  const onDone = useCallback(
    (text: string) => {
      setMessage(text)
      setPage(1)
      reloadBundle()
      reloadHistory()
    },
    [reloadBundle, reloadHistory],
  )
  // After a conflict or an uncertain result: show the current balance/history.
  const onRefresh = useCallback(() => {
    reloadBundle()
    reloadHistory()
  }, [reloadBundle, reloadHistory])

  // Last bundle that did load, with the time it was read. If a later reload
  // fails (no connection), the screen keeps it, clearly marked as not
  // updated, instead of unmounting the operations panel: the typed data and
  // the key of an operation with an uncertain result must survive.
  const [lastGood, setLastGood] = useState<{ data: BundleDetail; at: number } | null>(null)
  if (bundle.data && bundle.loadedAt !== null && bundle.data !== lastGood?.data) {
    setLastGood({ data: bundle.data, at: bundle.loadedAt })
  }
  const stale = bundle.error !== null && lastGood !== null

  if (bundle.error && !lastGood) {
    return (
      <>
        <PageHeader eyebrow="Inventario · Paquete" title="Paquete no disponible" />
        <Notice kind="error">{bundle.error}</Notice>
        <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'lookup' })}>
          Volver a la consulta
        </button>
      </>
    )
  }
  const data = bundle.data ?? lastGood?.data
  if (!data) return <Loading />

  return (
    <>
      <PageHeader
        eyebrow="Inventario · Paquete"
        title={<span className="mono">{data.epc}</span>}
        description={`${referenceLabel(data.reference)} · ${finishLabel(data.finish)}`}
        actions={
          <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'lookup' })}>
            Consultar otro chip
          </button>
        }
      />
      {message ? <Notice kind="success">{message}</Notice> : null}
      {stale && lastGood ? (
        <Notice kind="warning">
          No se pudo actualizar el paquete: {bundle.error} Los datos mostrados son de la consulta de las{' '}
          {formatDateTime(new Date(lastGood.at).toISOString())} y pueden no estar al día.{' '}
          <button type="button" className="link" onClick={onRefresh}>
            Reintentar
          </button>
        </Notice>
      ) : null}

      <div className="card detail-grid" aria-busy={bundle.loading}>
        <div>
          <span className="field-label">Referencia</span>
          <p>{referenceLabel(data.reference)}</p>
        </div>
        <div>
          <span className="field-label">Acabado</span>
          <p>{finishLabel(data.finish)}</p>
        </div>
        <div>
          <span className="field-label">Familia</span>
          <p>{data.reference.family ? `${data.reference.family.code} — ${data.reference.family.name}` : 'Sin familia'}</p>
        </div>
        <div>
          <span className="field-label">Perfiles disponibles</span>
          <p className="big">
            {data.quantity}
            {data.quantity === 0 ? <span className="badge badge-muted">Agotado</span> : null}
            {data.openedAt ? <span className="badge badge-loose">Abierto · sueltos</span> : null}
          </p>
        </div>
        <div>
          <span className="field-label">Ubicación</span>
          <p>{bundlePlace(data)}</p>
        </div>
        <div>
          <span className="field-label">Llegada física</span>
          <p>{formatArrival(data)}</p>
        </div>
        <div>
          <span className="field-label">Registrado en el sistema</span>
          <p>{formatDateTime(data.createdAt)}</p>
        </div>
        {data.notes ? (
          <div>
            <span className="field-label">Notas</span>
            <p>{data.notes}</p>
          </div>
        ) : null}
      </div>

      <h2 className="subtitle">Operaciones</h2>
      <div className="card">
        <OperationsPanel bundle={data} onDone={onDone} onRefresh={onRefresh} />
      </div>

      <h2 className="subtitle">Historial de movimientos</h2>
      {history.error ? <Notice kind="error">{history.error}</Notice> : null}
      {history.loading && !history.data ? <Loading /> : null}
      {history.data && history.data.items.length === 0 ? <Empty>Sin movimientos.</Empty> : null}
      {history.data && history.data.items.length > 0 ? (
        <>
          <div className="table-wrap stack" aria-busy={history.loading}>
            <table>
              <thead>
                <tr>
                  <th>Movimiento</th>
                  <th className="num">Cantidad</th>
                  <th className="num">Saldo</th>
                  <th>Ubicación</th>
                  <th>Responsable</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((movement) => (
                  <tr key={movement.id}>
                    <td className="card-title" data-label="Fecha">
                      <span className="cell-main">{MOVEMENT_LABELS[movement.type]}</span>
                      <span className="cell-sub">{formatDateTime(movement.occurredAt)}</span>
                    </td>
                    <td className="num" data-label="Cantidad">{movement.quantity}</td>
                    <td className="num" data-label="Saldo">
                      {movement.quantityBefore} → {movement.quantityAfter}
                    </td>
                    <td data-label="Ubicación">{movementPlaces(movement)}</td>
                    <td data-label="Responsable">{movement.performedBy.name}</td>
                    <td data-label="Motivo">{movement.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={history.data.page}
            totalPages={history.data.totalPages}
            total={history.data.total}
            onChange={setPage}
            disabled={history.loading}
          />
        </>
      ) : null}
    </>
  )
}
