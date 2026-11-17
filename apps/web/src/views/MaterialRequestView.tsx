import { useRef, useState, type FormEvent } from 'react'
import { ApiError, describeError } from '../api/client'
import type { InventoryLocation } from '../api/types'
import { CatalogSelectors } from '../components/CatalogSelectors'
import { IconScan } from '../components/icons'
import { Field, Loading, Notice, PageHeader } from '../components/ui'
import { ORIGIN_LABEL, type AvailabilityGroup, type MaterialOrigin, type Supplier } from '../lib/commerce'
import { EMPTY_CATALOG, type CatalogValue } from '../lib/forms'
import { formatDateTime } from '../lib/format'
import { REQUEST_STATUS_LABEL, type MaterialRequest, type Workers } from '../lib/materialRequests'
import { useLoad } from '../lib/useLoad'
import { uuid } from '../lib/uuid'
import { useUnsavedWork } from '../pwa/workGuard'
import { useSession } from '../session/session-context'
import type { Navigate } from './navigation'

export function MaterialRequestView({ id, navigate }: { id?: string; navigate: Navigate }) {
  return id ? <RequestDetail id={id} navigate={navigate} /> : <NewRequest navigate={navigate} />
}

// --- New request (Sales) ------------------------------------------------------------

interface LineDraft {
  key: string
  catalog: CatalogValue
  origin: MaterialOrigin
  supplierId: string
  quantity: string
}

const newLine = (): LineDraft => ({ key: uuid(), catalog: EMPTY_CATALOG, origin: 'CHINA', supplierId: '', quantity: '' })

type LocationOption = InventoryLocation & { branch: { id: string; name: string } }

// Today at 17:00 (Colombia) if it is still early, otherwise tomorrow at 17:00.
function defaultDue() {
  const now = new Date()
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(now)
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', hour12: false }).format(now))
  const date = hour < 15 ? today : new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  return { date, time: '17:00' }
}

function NewRequest({ navigate }: { navigate: Navigate }) {
  const { request } = useSession()
  const locations = useLoad<LocationOption[]>('/locations/inventory-locations')
  const suppliers = useLoad<Supplier[]>('/suppliers?active=true')
  const warehouses = (locations.data ?? []).filter((l) => l.type === 'WAREHOUSE')
  const stores = (locations.data ?? []).filter((l) => l.type === 'RETAIL_STORE')
  const [sourceId, setSourceId] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const source = sourceId || (warehouses.length === 1 ? warehouses[0].id : '')
  const destination = destinationId || (stores.length === 1 ? stores[0].id : '')
  const workers = useLoad<Workers>(source ? `/material-requests/workers?sourceLocationId=${encodeURIComponent(source)}` : null)
  const [assigneeId, setAssigneeId] = useState('')
  const [due, setDue] = useState(defaultDue)
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([newLine()])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef<string | null>(null)
  const inFlight = useRef(false)
  const touched = lines.some((line) => line.catalog.referenceId || line.quantity) || notes.trim() !== ''
  useUnsavedWork(touched ? 'Solicitud de materiales sin enviar' : null)

  const next = workers.data?.next ?? null
  const chosen = assigneeId || next?.id || ''
  const lineValid = (line: LineDraft) => !!line.catalog.referenceId && !!line.catalog.finishId && Number.isInteger(Number(line.quantity)) && Number(line.quantity) >= 1
  const blocker = !source
    ? 'Elige la bodega que abastece.'
    : !destination
      ? 'Elige el almacén destino.'
      : workers.data && workers.data.workers.length === 0
        ? 'La bodega no tiene bodegueros activos asignados.'
        : !lines.every(lineValid)
          ? 'Completa referencia, color y cantidad de cada renglón.'
          : !due.date || !due.time
            ? 'Indica la fecha límite.'
            : null

  const update = (index: number, patch: Partial<LineDraft>) => setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)))

  const send = async () => {
    if (inFlight.current || blocker) return
    inFlight.current = true
    key.current ??= uuid()
    setBusy(true)
    setError(null)
    try {
      const { data } = await request<MaterialRequest>('/material-requests', {
        method: 'POST',
        body: {
          operationKey: key.current,
          sourceLocationId: source,
          destinationLocationId: destination,
          dueAt: `${due.date}T${due.time}:00-05:00`,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(assigneeId && assigneeId !== next?.id ? { assigneeId } : {}),
          lines: lines.map((line) => ({
            referenceId: line.catalog.referenceId,
            finishId: line.catalog.finishId,
            origin: line.origin,
            ...(line.supplierId ? { supplierId: line.supplierId } : {}),
            quantity: Number(line.quantity),
          })),
        },
      })
      navigate({ name: 'request', id: data.id })
    } catch (err) {
      // Lost answer: the same key is resent and returns the same request.
      if (!(err instanceof ApiError && (err.status === 0 || err.status >= 500))) key.current = null
      setError(describeError(err))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Abastecimiento"
        title="Nueva solicitud de materiales"
        description="Pide perfiles a bodega para un almacén. No necesitas los paquetes ni leer chips: bodega los prepara. Enviarla no mueve ni reserva inventario."
        actions={
          <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'requests' })}>
            Volver a solicitudes
          </button>
        }
      />
      <section className="card">
        <div className="form-grid">
          <Field label="Bodega que abastece">
            <select value={source} onChange={(e) => { setSourceId(e.target.value); setAssigneeId('') }}>
              <option value="">Elige…</option>
              {warehouses.map((l) => <option key={l.id} value={l.id}>{l.branch.name} · {l.name}</option>)}
            </select>
          </Field>
          <Field label="Almacén destino">
            <select value={destination} onChange={(e) => setDestinationId(e.target.value)}>
              <option value="">Elige…</option>
              {stores.map((l) => <option key={l.id} value={l.id}>{l.branch.name} · {l.name}</option>)}
            </select>
          </Field>
          <Field
            label="Bodeguero que prepara"
            hint={next ? `Por turno le toca a ${next.name}. Cámbialo solo si no está disponible.` : source ? 'Cargando turno…' : 'Elige primero la bodega.'}
          >
            <select value={chosen} disabled={!workers.data || workers.data.workers.length === 0} onChange={(e) => setAssigneeId(e.target.value)}>
              {(workers.data?.workers ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.name}{w.id === next?.id ? ' (turno)' : ''}</option>
              ))}
            </select>
          </Field>
          <Field label="Fecha límite">
            <input type="date" value={due.date} onChange={(e) => setDue({ ...due, date: e.target.value })} />
          </Field>
          <Field label="Hora (Colombia)">
            <input type="time" value={due.time} onChange={(e) => setDue({ ...due, time: e.target.value })} />
          </Field>
          <Field label="Notas (opcional)">
            <input value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        {locations.error ? <Notice kind="error">{locations.error}</Notice> : null}
      </section>

      {lines.map((line, index) => (
        <RequestLineEditor
          key={line.key}
          line={line}
          index={index}
          sourceId={source}
          suppliers={(suppliers.data ?? []).filter((s) => s.origins.includes('NATIONAL'))}
          onChange={(patch) => update(index, patch)}
          onRemove={lines.length > 1 ? () => setLines((current) => current.filter((_, i) => i !== index)) : null}
        />
      ))}
      <button type="button" className="button button-secondary" onClick={() => setLines((current) => [...current, newLine()])}>
        + Agregar renglón
      </button>

      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="actions">
        <button type="button" className="button" disabled={busy || blocker !== null} onClick={() => void send()}>
          {busy ? 'Enviando…' : 'Enviar a bodega'}
        </button>
        {blocker && !busy ? <span className="cell-sub save-blocker">Para enviar: {blocker}</span> : null}
      </div>
    </>
  )
}

function RequestLineEditor({
  line,
  index,
  sourceId,
  suppliers,
  onChange,
  onRemove,
}: {
  line: LineDraft
  index: number
  sourceId: string
  suppliers: Supplier[]
  onChange: (patch: Partial<LineDraft>) => void
  onRemove: (() => void) | null
}) {
  const { referenceId, finishId } = line.catalog
  const enc = encodeURIComponent
  const availability = useLoad<AvailabilityGroup[]>(
    referenceId && finishId && sourceId ? `/sales/availability?referenceId=${enc(referenceId)}&finishId=${enc(finishId)}&inventoryLocationId=${enc(sourceId)}` : null,
  )
  const available = (availability.data ?? [])
    .filter((g) => g.origin === line.origin && (!line.supplierId || g.supplier?.id === line.supplierId))
    .reduce((total, g) => total + g.available, 0)
  return (
    <fieldset className="card quote-line">
      <legend className="quote-line-title">Renglón {index + 1}</legend>
      <div className="form-grid">
        <CatalogSelectors mode="form" value={line.catalog} onChange={(catalog) => onChange({ catalog })} />
        <Field label="Origen requerido" hint="China y Nacional son materiales distintos aunque coincidan referencia y color.">
          <select value={line.origin} onChange={(e) => onChange({ origin: e.target.value as MaterialOrigin, supplierId: '' })}>
            <option value="CHINA">China</option>
            <option value="NATIONAL">Nacional</option>
          </select>
        </Field>
        {line.origin === 'NATIONAL' ? (
          <Field label="Proveedor (opcional)" hint="Solo si debe ser de un proveedor en particular.">
            <select value={line.supplierId} onChange={(e) => onChange({ supplierId: e.target.value })}>
              <option value="">Cualquier proveedor</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        ) : null}
        <Field label="Perfiles" hint="Cantidad de perfiles, no de paquetes. Bodega envía paquetes completos.">
          <input type="number" inputMode="numeric" min={1} max={1000000} value={line.quantity} onChange={(e) => onChange({ quantity: e.target.value })} />
        </Field>
      </div>
      <div className="quote-line-info">
        {availability.data ? (
          <span>
            Disponible en la bodega ({ORIGIN_LABEL[line.origin]}): <strong>{available.toLocaleString('es-CO')}</strong> perfiles
          </span>
        ) : null}
        {onRemove ? <button type="button" className="text-button danger" onClick={onRemove}>Quitar renglón</button> : null}
      </div>
    </fieldset>
  )
}

// --- Detail: preparation, shipment, reception ---------------------------------------

function RequestDetail({ id, navigate }: { id: string; navigate: Navigate }) {
  const { request } = useSession()
  const detail = useLoad<MaterialRequest>(`/material-requests/${encodeURIComponent(id)}`)
  // The answer of the last action, until a newer load replaces it.
  const [local, setLocal] = useState<{ data: MaterialRequest; at: number } | null>(null)
  const data = local && local.at > (detail.loadedAt ?? 0) ? local.data : detail.data
  const setData = (value: MaterialRequest) => setLocal({ data: value, at: Date.now() })
  const [chip, setChip] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [shipping, setShipping] = useState(false)
  const [note, setNote] = useState('')
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [newAssignee, setNewAssignee] = useState('')
  const shipKey = useRef<string | null>(null)
  const inFlight = useRef(false)
  const chipInput = useRef<HTMLInputElement>(null)
  const workers = useLoad<Workers>(data?.can.reassign ? `/material-requests/workers?sourceLocationId=${encodeURIComponent(data.source.id)}` : null)
  useUnsavedWork(shipping ? 'Salida de solicitud sin confirmar' : null)

  const act = async <T,>(path: string, body: unknown, success?: (result: T) => string | null) => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    try {
      const { data: result } = await request<T>(`/material-requests/${encodeURIComponent(id)}${path}`, { method: 'POST', body })
      const view = (result as { request?: MaterialRequest }).request ?? (result as unknown as MaterialRequest)
      setData(view)
      const text = success?.(result) ?? null
      setMessage(text ? { kind: 'success', text } : null)
      return true
    } catch (err) {
      setMessage({ kind: 'error', text: describeError(err) })
      if (err instanceof ApiError && err.status === 409) detail.reload()
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (!data) return detail.error ? <Notice kind="error">{detail.error}</Notice> : <Loading />

  const readChip = async (event: FormEvent) => {
    event.preventDefault()
    const epc = chip.trim().toUpperCase()
    if (!epc) return
    const ok = await act<{ message: string }>('/picks', { epc }, (r) => r.message)
    if (ok) setChip('')
    chipInput.current?.focus()
  }

  const ship = async () => {
    shipKey.current ??= uuid()
    const ok = await act<MaterialRequest>('/ship', { operationKey: shipKey.current }, () => `Salida confirmada: ${data.totals.bundles} paquetes trasladados a ${data.destination.name}. Allá quedaron como perfiles sueltos.`)
    if (ok) {
      shipKey.current = null
      setShipping(false)
    }
  }

  const facts = [
    `${data.source.branch.name} · ${data.source.name} → ${data.destination.branch.name} · ${data.destination.name}`,
    `Pidió ${data.createdBy.name} · ${formatDateTime(data.createdAt)}`,
    `Fecha límite ${formatDateTime(data.dueAt)}`,
  ]

  return (
    <>
      <PageHeader
        eyebrow="Solicitud de materiales"
        title={data.number}
        description={facts.join(' · ')}
        actions={
          <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'requests' })}>
            Volver a solicitudes
          </button>
        }
      />
      <p className="doc-facts">
        <span>Estado: <strong>{REQUEST_STATUS_LABEL[data.status]}</strong></span>
        <span>Prepara: <strong>{data.assignee.name}</strong></span>
        {data.shippedAt ? <span>Salió {formatDateTime(data.shippedAt)} · {data.shippedBy?.name}</span> : null}
        {data.reception ? <span>Recibe: <strong>{data.reception.assignee.name}</strong></span> : null}
        {data.receivedAt ? <span>Recibida {formatDateTime(data.receivedAt)} · {data.receivedBy?.name}</span> : null}
      </p>
      {data.notes ? <Notice kind="info">Nota de la solicitud: {data.notes}</Notice> : null}
      {data.receptionNote ? <Notice kind="info">Novedad en la recepción: {data.receptionNote}</Notice> : null}
      {data.cancelledAt ? <Notice kind="warning">Cancelada por {data.cancelledBy?.name} · {formatDateTime(data.cancelledAt)}: {data.cancelReason}</Notice> : null}
      {message ? <Notice kind={message.kind}>{message.text}</Notice> : null}

      <section className="card">
        <h2 className="subtitle">Materiales</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th><th>Material</th><th>Origen</th><th className="num">Solicitado</th><th className="num">Preparado</th><th className="num">Despachado</th><th className="num">Pendiente</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line) => (
                <tr key={line.id}>
                  <td data-label="#">{line.lineNo}</td>
                  <td data-label="Material">
                    {line.referenceCode} · {line.finishDescription ?? line.finishCode}
                    {line.referenceDescription ? <span className="cell-sub"> {line.referenceDescription}</span> : null}
                  </td>
                  <td data-label="Origen">{ORIGIN_LABEL[line.origin]}{line.supplierName ? ` · ${line.supplierName}` : ''}</td>
                  <td className="num" data-label="Solicitado">{line.requested.toLocaleString('es-CO')}</td>
                  <td className="num" data-label="Preparado">{line.prepared.toLocaleString('es-CO')}</td>
                  <td className="num" data-label="Despachado">{line.shipped.toLocaleString('es-CO')}</td>
                  <td className="num" data-label="Pendiente">{line.pending.toLocaleString('es-CO')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="cell-sub">
          En perfiles. Bodega envía paquetes completos, así que lo preparado puede superar lo solicitado. Total: {data.totals.requested.toLocaleString('es-CO')} solicitados ·{' '}
          {data.totals.prepared.toLocaleString('es-CO')} preparados en {data.totals.bundles} {data.totals.bundles === 1 ? 'paquete' : 'paquetes'} · {data.totals.shipped.toLocaleString('es-CO')} despachados.
        </p>
      </section>

      {data.can.prepare ? (
        <section className="card request-prepare">
          <h2 className="subtitle">Preparar</h2>
          <form className="transfer-add" onSubmit={(e) => void readChip(e)}>
            <Field label="Leer chip del paquete" hint="Con la pistola en modo teclado o escribiendo el código y Enter. Se reserva el paquete completo.">
              <span className="input-wrap">
                <IconScan />
                <input
                  ref={chipInput}
                  className="mono"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="E2003412…"
                  value={chip}
                  disabled={busy}
                  onChange={(e) => setChip(e.target.value.toUpperCase())}
                />
              </span>
            </Field>
            <button type="submit" className="button button-secondary" disabled={busy || !chip.trim()}>Agregar</button>
          </form>
          {data.lines.some((line) => line.suggestions.length > 0) ? (
            <div className="request-suggestions">
              <h3>Paquetes disponibles en {data.source.name}</h3>
              {data.lines.filter((line) => line.suggestions.length > 0).map((line) => (
                <div key={line.id}>
                  <p className="cell-sub">Renglón {line.lineNo} · faltan {line.pending.toLocaleString('es-CO')} perfiles {line.referenceCode} {line.finishDescription ?? line.finishCode}</p>
                  <ul className="transfer-list">
                    {line.suggestions.map((s) => (
                      <li key={s.bundleId}>
                        <span>
                          <span className="mono">{s.epc}</span>
                          <small>{s.quantity} perf.{s.aisle !== null ? ` · Pasillo ${s.aisle} · Burro ${s.rack}` : ''}{s.loose ? ' · sueltos (paquete abierto)' : ' · cerrado'}</small>
                        </span>
                        {s.loose ? (
                          <button type="button" className="button button-secondary" disabled={busy} onClick={() => void act<{ message: string }>('/picks', { bundleId: s.bundleId }, (r) => r.message)}>
                            Tomar sueltos
                          </button>
                        ) : (
                          <span className="badge badge-muted">Lee su chip</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {data.picks.length > 0 ? (
        <section className="card">
          <h2 className="subtitle">Paquetes {data.status === 'SHIPPED' || data.status === 'RECEIVED' ? 'despachados' : 'preparados'}</h2>
          <ul className="transfer-list">
            {data.picks.map((pick) => (
              <li key={pick.id}>
                <span>
                  <span className="mono">{pick.bundle.epc}</span>
                  <small>
                    Renglón {data.lines.find((l) => l.id === pick.lineId)?.lineNo} · {pick.quantity} perf.{pick.bundle.loose ? ' · sueltos' : ''}
                    {pick.bundle.origin ? ` · ${ORIGIN_LABEL[pick.bundle.origin]}` : ''}{pick.bundle.supplier ? ` · ${pick.bundle.supplier}` : ''}{pick.bundle.lot ? ` · lote ${pick.bundle.lot}` : ''}
                  </small>
                </span>
                {data.can.prepare ? (
                  <button type="button" className="text-button danger" disabled={busy} onClick={() => void act(`/picks/${encodeURIComponent(pick.id)}/remove`, {})}>
                    Quitar
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {data.can.ship ? (
            shipping ? (
              <div className="confirm" role="alertdialog" aria-label="Confirmar salida">
                <div>
                  ¿Salieron físicamente los <strong>{data.totals.bundles}</strong> {data.totals.bundles === 1 ? 'paquete' : 'paquetes'} ({data.totals.prepared.toLocaleString('es-CO')} perfiles) hacia{' '}
                  <strong>{data.destination.name}</strong>? Se trasladan completos y allá quedan abiertos, como perfiles sueltos disponibles para la venta.
                </div>
                <div className="actions">
                  <button type="button" className="button button-danger" disabled={busy} onClick={() => void ship()}>
                    {busy ? 'Confirmando…' : 'Confirmar salida física'}
                  </button>
                  <button type="button" className="button button-secondary" disabled={busy} onClick={() => setShipping(false)}>Volver</button>
                </div>
              </div>
            ) : (
              <div className="actions">
                <button type="button" className="button" onClick={() => setShipping(true)}>Revisar y confirmar salida</button>
                {data.lines.some((line) => line.pending > 0) ? <span className="cell-sub">Faltan perfiles en algún renglón: puedes despachar lo preparado; lo demás se pide en otra solicitud.</span> : null}
              </div>
            )
          ) : null}
        </section>
      ) : null}

      {data.can.receive ? (
        <section className="card">
          <h2 className="subtitle">Recepción en {data.destination.name}</h2>
          <Field label="Novedades (opcional)" hint="Por ejemplo, un paquete que no llegó o llegó dañado." wide>
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="actions">
            <button type="button" className="button" disabled={busy} onClick={() => void act('/receive', note.trim() ? { note: note.trim() } : {}, () => 'Pedido marcado como recibido.')}>
              Marcar como recibido
            </button>
          </div>
        </section>
      ) : null}

      {data.can.reassign || data.can.cancel ? (
        <section className="card">
          <h2 className="subtitle">Cambios</h2>
          {data.can.reassign ? (
            <div className="form-grid">
              <Field label="Cambiar bodeguero" hint="Por ejemplo, si quien tiene el turno no vino.">
                <select value={newAssignee || data.assignee.id} onChange={(e) => setNewAssignee(e.target.value)}>
                  {(workers.data?.workers ?? [data.assignee]).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </Field>
              <div className="actions">
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy || !newAssignee || newAssignee === data.assignee.id}
                  onClick={() => void act('/assignee', { assigneeId: newAssignee }, () => 'Responsable cambiado; le llegó la tarea.').then((ok) => ok && setNewAssignee(''))}
                >
                  Cambiar responsable
                </button>
              </div>
            </div>
          ) : null}
          {data.can.cancel ? (
            cancelling !== null ? (
              <div className="form-grid">
                <Field label="Motivo de la cancelación">
                  <input value={cancelling} maxLength={300} onChange={(e) => setCancelling(e.target.value)} />
                </Field>
                <div className="actions">
                  <button type="button" className="button button-danger" disabled={busy || !cancelling.trim()} onClick={() => void act('/cancel', { reason: cancelling.trim() }, () => 'Solicitud cancelada; lo preparado quedó libre.').then((ok) => ok && setCancelling(null))}>
                    Cancelar solicitud
                  </button>
                  <button type="button" className="text-button" disabled={busy} onClick={() => setCancelling(null)}>Volver</button>
                </div>
              </div>
            ) : (
              <button type="button" className="text-button danger" onClick={() => setCancelling('')}>Cancelar solicitud…</button>
            )
          ) : null}
        </section>
      ) : null}
    </>
  )
}
