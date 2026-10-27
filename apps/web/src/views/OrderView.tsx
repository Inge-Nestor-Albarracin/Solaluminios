import { useRef, useState } from 'react'
import { ApiError, describeError } from '../api/client'
import { LocationSelectors } from '../components/LocationSelectors'
import { DownloadPdfButton } from '../components/DownloadPdfButton'
import { Field, Loading, Notice, PageHeader } from '../components/ui'
import {
  DISPATCH_STATUS_LABEL,
  ORDER_STATUS_LABEL,
  ORIGIN_LABEL,
  formatMoney,
  type SalesOrder,
  type Shortage,
} from '../lib/commerce'
import { EMPTY_LOCATION, type LocationValue } from '../lib/forms'
import { formatDateTime, todayIso } from '../lib/format'
import { useLoad } from '../lib/useLoad'
import { uuid } from '../lib/uuid'
import { useUnsavedWork } from '../pwa/workGuard'
import { useSession } from '../session/session-context'
import type { Navigate } from './navigation'

// Sales order: confirmation reserves everything or nothing (shortages are
// shown and the order waits for supply); deliveries are dispatches assigned
// to a warehouse worker of the order's location.
export function OrderView({ id, navigate }: { id: string; navigate: Navigate }) {
  const { request } = useSession()
  const enc = encodeURIComponent
  const order = useLoad<SalesOrder>(`/sales-orders/${enc(id)}`)
  const [location, setLocation] = useState<LocationValue>(EMPTY_LOCATION)
  const [shortages, setShortages] = useState<Shortage[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState<string | null>(null)
  const [dispatchForm, setDispatchForm] = useState<{ assigneeId: string; date: string; time: string; partial: boolean; quantities: Record<string, string> } | null>(null)
  const dispatchKey = useRef<string | null>(null)
  const data = order.data
  // Dispatches leave from the location where the order was reserved (or the
  // one chosen for a partial delivery of an unreserved order).
  const dispatchLocation = data?.inventoryLocation?.id ?? location.inventoryLocationId
  const assignees = useLoad<{ id: string; name: string }[]>(
    dispatchForm && dispatchLocation ? `/dispatches/eligible-assignees?inventoryLocationId=${enc(dispatchLocation)}` : null,
  )

  useUnsavedWork(dispatchForm ? 'Despacho de una orden sin crear' : cancelReason ? 'Cancelación de orden sin confirmar' : null)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const confirm = () =>
    run(async () => {
      const { data: result } = await request<{ confirmed: boolean; shortages: Shortage[] }>(`/sales-orders/${enc(id)}/confirm`, {
        method: 'POST',
        body: { inventoryLocationId: location.inventoryLocationId },
      })
      setShortages(result.confirmed ? null : result.shortages)
      order.reload()
    })

  const openDispatchForm = (partial: boolean) => {
    if (!data) return
    dispatchKey.current = null
    const quantities: Record<string, string> = {}
    for (const line of data.lines) if (line.unauthorisedQuantity > 0) quantities[line.id] = partial ? '' : String(line.unauthorisedQuantity)
    setDispatchForm({ assigneeId: '', date: todayIso(), time: '17:00', partial, quantities })
  }

  const createDispatch = () =>
    run(async () => {
      if (!dispatchForm || !data) return
      const lines = Object.entries(dispatchForm.quantities)
        .filter(([, q]) => Number(q) > 0)
        .map(([salesOrderLineId, q]) => ({ salesOrderLineId, quantity: Number(q) }))
      dispatchKey.current ??= uuid()
      try {
        const { data: created } = await request<{ id: string }>(`/sales-orders/${enc(id)}/dispatches`, {
          method: 'POST',
          body: {
            operationKey: dispatchKey.current,
            assigneeId: dispatchForm.assigneeId,
            dueAt: `${dispatchForm.date}T${dispatchForm.time}:00-05:00`,
            lines,
            ...(dispatchForm.partial ? { partial: true, ...(data.inventoryLocation ? {} : { inventoryLocationId: location.inventoryLocationId }) } : {}),
          },
        })
        dispatchKey.current = null
        setDispatchForm(null)
        navigate({ name: 'dispatch', id: created.id })
      } catch (err) {
        if (!(err instanceof ApiError && (err.status === 0 || err.status >= 500))) dispatchKey.current = null
        throw err
      }
    })

  const cancel = () =>
    run(async () => {
      await request(`/sales-orders/${enc(id)}/cancel`, { method: 'POST', body: { reason: cancelReason?.trim() } })
      setCancelReason(null)
      order.reload()
    })

  if (order.loading && !data) return <Loading />
  if (order.error && !data) return <Notice kind="error">{order.error}</Notice>
  if (!data) return null

  const canConfirm = data.status === 'DRAFT' || data.status === 'PENDING_SUPPLY'
  const pendingToAuthorise = data.lines.some((line) => line.unauthorisedQuantity > 0)
  const canDispatchFull = data.status === 'CONFIRMED' && pendingToAuthorise
  const canDispatchPartial = (data.status === 'DRAFT' || data.status === 'PENDING_SUPPLY') && pendingToAuthorise

  return (
    <>
      <PageHeader
        eyebrow="Ventas · Orden"
        title={data.number}
        description={`${data.customerName} · ${ORDER_STATUS_LABEL[data.status]}${data.inventoryLocation ? ` · sale de ${data.inventoryLocation.name}` : ''}`}
        actions={
          <>
            <DownloadPdfButton path={`/sales-orders/${encodeURIComponent(data.id)}/pdf`} fallbackName={data.number} />
            <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'sales', tab: 'orders' })}>
              Volver a ventas
            </button>
          </>
        }
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {data.status === 'CANCELLED' ? <Notice kind="warning">Orden cancelada: {data.cancelReason}</Notice> : null}

      <section className="card">
        <h2 className="subtitle">Renglones</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th><th>Material</th><th>Origen</th><th className="num">Pedido</th><th className="num">Reservado</th><th className="num">En despachos</th><th className="num">Entregado</th><th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line) => (
                <tr key={line.id}>
                  <td data-label="#">{line.lineNo}</td>
                  <td data-label="Material">{line.referenceCode} · {line.finishDescription ?? line.finishCode}</td>
                  <td data-label="Origen">{ORIGIN_LABEL[line.origin]}{line.supplierName ? ` · solo ${line.supplierName}` : ''}</td>
                  <td className="num" data-label="Pedido">{line.quantity}</td>
                  <td className="num" data-label="Reservado">{line.reservedQuantity}</td>
                  <td className="num" data-label="En despachos">{line.authorisedQuantity}</td>
                  <td className="num" data-label="Entregado">{line.dispatchedQuantity}</td>
                  <td className="num" data-label="Total">{formatMoney(line.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="quote-totals">
          Subtotal {formatMoney(data.subtotal)} · Descuentos {formatMoney(data.discountTotal)} · IVA {formatMoney(data.taxTotal)} · <strong>Total {formatMoney(data.total)}</strong>
        </p>
      </section>

      {canConfirm ? (
        <section className="card">
          <h2 className="subtitle">Confirmar y reservar</h2>
          <p className="field-hint">Se reserva la cantidad completa de cada renglón en la ubicación elegida, o nada. Si falta material, la orden queda pendiente de abastecimiento.</p>
          <div className="form-grid">
            <LocationSelectors value={location} onChange={setLocation} mode="form" depth="location" />
          </div>
          {shortages ? (
            <Notice kind="warning">
              No hay material suficiente; no se reservó nada:
              <ul>
                {shortages.map((s) => (
                  <li key={s.lineNo}>
                    Renglón {s.lineNo} ({s.referenceCode} {s.finishCode}, {ORIGIN_LABEL[s.origin]}): requiere {s.required}, disponibles {s.available}, faltan <strong>{s.missing}</strong>
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <div className="actions">
            <button type="button" className="button" disabled={busy || !location.inventoryLocationId} onClick={() => void confirm()}>
              Confirmar orden
            </button>
          </div>
        </section>
      ) : null}

      <section className="card">
        <h2 className="subtitle">Despachos</h2>
        {data.dispatches.length === 0 ? <p className="field-hint">Aún no hay despachos.</p> : null}
        <ul className="doc-list">
          {data.dispatches.map((dispatch) => (
            <li key={dispatch.id}>
              <button type="button" className="doc-row" onClick={() => navigate({ name: 'dispatch', id: dispatch.id })}>
                <span className="doc-main">
                  <strong>{dispatch.number}{dispatch.partial ? ' · parcial' : ''}</strong>
                  <small>{dispatch.assignee.name} · plazo {formatDateTime(dispatch.dueAt)}</small>
                </span>
                <span className="doc-side">
                  {dispatch._count.incidents > 0 ? <span className="badge badge-warning">{dispatch._count.incidents} incidencias</span> : null}
                  <span className="badge">{DISPATCH_STATUS_LABEL[dispatch.status]}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {!dispatchForm && (canDispatchFull || canDispatchPartial) ? (
          <div className="actions">
            {canDispatchFull ? <button type="button" className="button" onClick={() => openDispatchForm(false)}>Crear despacho</button> : null}
            <button type="button" className="button button-secondary" onClick={() => openDispatchForm(true)}>
              Autorizar entrega parcial
            </button>
          </div>
        ) : null}
        {dispatchForm ? (
          <div className="dispatch-form">
            {dispatchForm.partial ? (
              <Notice kind="info">Entrega parcial: se reserva solo lo que autorices aquí; el resto de la orden queda pendiente.</Notice>
            ) : null}
            {dispatchForm.partial && !data.inventoryLocation ? (
              <div className="form-grid">
                <LocationSelectors value={location} onChange={setLocation} mode="form" depth="location" />
              </div>
            ) : null}
            <div className="form-grid">
              {data.lines.filter((line) => line.unauthorisedQuantity > 0).map((line) => (
                <Field key={line.id} label={`Renglón ${line.lineNo}: ${line.referenceCode} ${ORIGIN_LABEL[line.origin]}`} hint={`Hasta ${line.unauthorisedQuantity} perfiles`}>
                  <input
                    type="number"
                    min={0}
                    max={line.unauthorisedQuantity}
                    value={dispatchForm.quantities[line.id] ?? ''}
                    onChange={(e) => setDispatchForm({ ...dispatchForm, quantities: { ...dispatchForm.quantities, [line.id]: e.target.value } })}
                  />
                </Field>
              ))}
              <Field label="Responsable de bodega" hint="Usuarios de bodega asignados a la ubicación de salida.">
                <select value={dispatchForm.assigneeId} onChange={(e) => setDispatchForm({ ...dispatchForm, assigneeId: e.target.value })}>
                  <option value="">Elige…</option>
                  {(assignees.data ?? []).map((user) => (
                    <option key={user.id} value={user.id}>{user.name}</option>
                  ))}
                </select>
                {assignees.data && assignees.data.length === 0 ? <span className="field-error">No hay usuarios de bodega con esa ubicación (Administración → Usuarios).</span> : null}
              </Field>
              <Field label="Fecha límite">
                <input type="date" value={dispatchForm.date} onChange={(e) => setDispatchForm({ ...dispatchForm, date: e.target.value })} />
              </Field>
              <Field label="Hora (Colombia)">
                <input type="time" value={dispatchForm.time} onChange={(e) => setDispatchForm({ ...dispatchForm, time: e.target.value })} />
              </Field>
            </div>
            <div className="actions">
              <button type="button" className="button" disabled={busy || !dispatchForm.assigneeId} onClick={() => void createDispatch()}>
                {busy ? 'Creando…' : 'Crear despacho y tarea'}
              </button>
              <button type="button" className="text-button" onClick={() => setDispatchForm(null)}>Cancelar</button>
            </div>
          </div>
        ) : null}
      </section>

      {data.status !== 'CANCELLED' && data.status !== 'COMPLETED' ? (
        <section className="card">
          {cancelReason === null ? (
            <button type="button" className="text-button danger" onClick={() => setCancelReason('')}>Cancelar orden…</button>
          ) : (
            <>
              <Field label="Motivo de la cancelación" hint="Libera las reservas y los despachos abiertos; las salidas ya confirmadas se conservan.">
                <input value={cancelReason} maxLength={500} onChange={(e) => setCancelReason(e.target.value)} />
              </Field>
              <div className="actions">
                <button type="button" className="button button-danger" disabled={busy || !cancelReason.trim()} onClick={() => void cancel()}>Cancelar orden</button>
                <button type="button" className="text-button" onClick={() => setCancelReason(null)}>Volver</button>
              </div>
            </>
          )}
        </section>
      ) : null}
    </>
  )
}
