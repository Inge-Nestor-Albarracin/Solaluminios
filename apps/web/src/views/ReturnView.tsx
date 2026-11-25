import { useRef, useState, type FormEvent } from 'react'
import { ApiError, describeError } from '../api/client'
import { IconScan } from '../components/icons'
import { Field, Kpi, Loading, Notice, PageHeader } from '../components/ui'
import { ENTITY_PLACEHOLDER, ORIGIN_LABEL, formatMoney, type TransferEntity } from '../lib/commerce'
import { formatDateTime } from '../lib/format'
import { RETURN_STATUS_BADGE, RETURN_STATUS_LABEL, profiles, type SalesReturn } from '../lib/returns'
import { useLoad } from '../lib/useLoad'
import { uuid } from '../lib/uuid'
import { useUnsavedWork } from '../pwa/workGuard'
import { useSession } from '../session/session-context'
import type { Navigate } from './navigation'

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date())
// «2026-11-25» → «25/11/2026».
const dayLabel = (value: string) => value.split('-').reverse().join('/')

// A sales return (documento DV) and the step each role takes on it:
// - administrator: authorise or reject a seller's request;
// - seller / administrator: cancel it before reception, record the refund;
// - warehouse / administrator: receive it (count good and damaged, read the
//   chip of the bundles that come back closed);
// - billing / administrator: the credit note of an invoiced order.
// The warehouse never sees money.
export function ReturnView({ id, navigate, onChanged }: { id: string; navigate: Navigate; onChanged?: () => void }) {
  const { request, user } = useSession()
  const role = user?.role
  const item = useLoad<SalesReturn>(`/sales-returns/${encodeURIComponent(id)}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answer, setAnswer] = useState<{ kind: 'approve' | 'reject' | 'cancel'; text: string } | null>(null)
  const lock = useRef(false)
  useUnsavedWork(answer?.text.trim() ? 'Respuesta de una devolución sin guardar' : null)

  const run = async (action: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      item.reload()
      onChanged?.()
    } catch (err) {
      setError(describeError(err))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  if (item.loading && !item.data) return <Loading />
  if (item.error && !item.data) return <Notice kind="error">{item.error}</Notice>
  if (!item.data) return null
  const data = item.data
  const money = data.amount !== undefined || data.estimatedAmount !== undefined
  const canSeeOrder = role === 'ADMIN' || role === 'SALES' || role === 'BILLING'
  const open = data.status === 'REQUESTED' || data.status === 'APPROVED'

  const act = (kind: 'approve' | 'reject' | 'cancel', text: string) =>
    run(async () => {
      const body = kind === 'approve' ? (text.trim() ? { note: text.trim() } : {}) : { reason: text.trim() }
      await request(`/sales-returns/${encodeURIComponent(id)}/${kind}`, { method: 'POST', body })
      setAnswer(null)
    })

  return (
    <>
      <PageHeader
        eyebrow="Devolución de cliente"
        title={data.number}
        description={`${data.order.customerName} · orden ${data.order.number} · se recibe en ${data.location.name}`}
        actions={
          <>
            {canSeeOrder ? (
              <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'order', id: data.order.id })}>
                Ver orden {data.order.number}
              </button>
            ) : null}
            <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'tasks' })}>
              Ir a tareas
            </button>
          </>
        }
      />
      <p className="doc-facts">
        <span>
          Estado: <span className={RETURN_STATUS_BADGE[data.status]}>{RETURN_STATUS_LABEL[data.status]}</span>
        </span>
        <span>
          Pedida por <strong>{data.requestedBy.name}</strong> · {formatDateTime(data.createdAt)}
        </span>
        <span>
          Motivo: <strong>{data.reasonLabel}</strong>
        </span>
        {money ? (
          <span>
            Dinero pagado de más: <strong>{data.settlementLabel}</strong>
          </span>
        ) : null}
        {data.notes ? <span>Observación: «{data.notes}»</span> : null}
      </p>
      {data.status === 'REQUESTED' && data.approver ? <Notice kind="info">Espera la autorización de {data.approver.name}.</Notice> : null}
      {data.decidedBy && data.status !== 'REQUESTED' ? (
        <Notice kind={data.status === 'REJECTED' ? 'warning' : 'info'}>
          {data.status === 'REJECTED' ? 'Rechazada' : 'Autorizada'} por {data.decidedBy.name}
          {data.decidedAt ? ` (${formatDateTime(data.decidedAt)})` : ''}
          {data.decisionNote ? `: «${data.decisionNote}»` : '.'}
          {data.status === 'APPROVED' && data.receiver ? ` La recibe ${data.receiver.name} en ${data.location.name}.` : ''}
        </Notice>
      ) : null}
      {data.status === 'CANCELLED' ? (
        <Notice kind="warning">
          Cancelada por {data.cancelledBy?.name ?? '—'}
          {data.cancelledAt ? ` (${formatDateTime(data.cancelledAt)})` : ''}: «{data.cancelReason}»
        </Notice>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}

      <section className="card">
        <h2 className="subtitle">Renglones</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Material</th>
                <th>Origen</th>
                <th className="num">Pedido a devolver</th>
                {data.status === 'RECEIVED' ? (
                  <>
                    <th className="num">Buen estado</th>
                    <th className="num">Dañados</th>
                  </>
                ) : null}
                {money ? <th className="num">Valor</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line) => (
                <tr key={line.id}>
                  <td data-label="#">{line.lineNo}</td>
                  <td data-label="Material">
                    {line.referenceCode} · {line.finishDescription ?? line.finishCode}
                    {line.movements.length > 0 ? (
                      <small className="cell-sub">
                        Volvió a:{' '}
                        {line.movements.map((m) => `${m.epc} (${profiles(m.quantity)}${m.closed ? ', cerrado' : ', sueltos'})`).join(' · ')}
                      </small>
                    ) : null}
                  </td>
                  <td data-label="Origen">{ORIGIN_LABEL[line.origin]}</td>
                  <td className="num" data-label="Pedido a devolver">
                    {line.quantity} de {line.orderedQuantity}
                  </td>
                  {data.status === 'RECEIVED' ? (
                    <>
                      <td className="num" data-label="Buen estado">{line.goodQuantity}</td>
                      <td className="num" data-label="Dañados">{line.damagedQuantity}</td>
                    </>
                  ) : null}
                  {money ? (
                    <td className="num" data-label="Valor">
                      {line.amount ? formatMoney(line.amount) : line.estimatedAmount ? `≈ ${formatMoney(line.estimatedAmount)}` : '—'}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {money ? (
          data.status === 'RECEIVED' && data.amount ? (
            <div className="kpis">
              <Kpi label="Valor devuelto (con IVA)" value={formatMoney(data.amount)} hint={`Base sin IVA ${formatMoney(data.baseAmount ?? '0')}`} />
              <Kpi
                label={data.settlement === 'CREDIT' ? 'Saldo a favor del cliente' : 'Reintegro al cliente'}
                value={formatMoney(data.settledAmount ?? '0')}
                hint={
                  Number(data.settledAmount) > 0
                    ? 'Lo que ya había pagado de más'
                    : 'El valor solo descontó lo que debía de la orden'
                }
              />
              <Kpi label="Descontado del saldo de la orden" value={formatMoney(Number(data.amount) - Number(data.settledAmount ?? 0))} />
            </div>
          ) : data.estimatedAmount ? (
            <p className="quote-totals">
              Valor aproximado <strong>{formatMoney(data.estimatedAmount)}</strong> (se calcula exacto con lo que llegue a bodega)
            </p>
          ) : null
        ) : null}
        {data.status === 'RECEIVED' ? (
          <p className="cell-sub">
            Recibida por {data.receivedBy?.name ?? '—'} · {data.receivedAt ? formatDateTime(data.receivedAt) : ''}
            {data.receptionNote ? ` · «${data.receptionNote}»` : ''}
          </p>
        ) : null}
      </section>

      {role === 'ADMIN' && data.status === 'REQUESTED' ? (
        <section className="card">
          <h2 className="subtitle">Autorizar</h2>
          {answer && answer.kind !== 'cancel' ? (
            <>
              <Field label={answer.kind === 'approve' ? 'Nota (opcional)' : 'Motivo del rechazo'}>
                <input value={answer.text} maxLength={500} autoFocus disabled={busy} onChange={(e) => setAnswer({ ...answer, text: e.target.value })} />
              </Field>
              <div className="actions">
                <button
                  type="button"
                  className={answer.kind === 'approve' ? 'button' : 'button button-danger'}
                  disabled={busy || (answer.kind === 'reject' && answer.text.trim().length < 3)}
                  onClick={() => void act(answer.kind, answer.text)}
                >
                  {busy ? 'Guardando…' : answer.kind === 'approve' ? 'Autorizar devolución' : 'Rechazar devolución'}
                </button>
                <button type="button" className="text-button" disabled={busy} onClick={() => setAnswer(null)}>
                  Volver
                </button>
              </div>
            </>
          ) : (
            <div className="actions">
              <button type="button" className="button" onClick={() => setAnswer({ kind: 'approve', text: '' })}>
                Autorizar…
              </button>
              <button type="button" className="button button-secondary" onClick={() => setAnswer({ kind: 'reject', text: '' })}>
                Rechazar…
              </button>
            </div>
          )}
        </section>
      ) : null}

      {(role === 'ADMIN' || role === 'WAREHOUSE') && data.status === 'APPROVED' ? (
        <ReceiveForm item={data} onSaved={() => { item.reload(); onChanged?.() }} />
      ) : null}

      {(role === 'ADMIN' || role === 'SALES') && data.refundPending ? (
        <RefundForm item={data} onSaved={() => item.reload()} />
      ) : null}
      {data.refund ? (
        <section className="card">
          <h2 className="subtitle">Reintegro</h2>
          <p>
            {formatMoney(data.settledAmount ?? '0')} entregados el {data.refund.refundedOn ? dayLabel(data.refund.refundedOn) : '—'} en{' '}
            {data.refund.medium === 'CASH' ? 'efectivo' : `transferencia desde ${data.refund.transferEntity?.name ?? '—'}`}
            {data.refund.by ? ` · registró ${data.refund.by.name}` : ''}
            {data.refund.note ? ` · «${data.refund.note}»` : ''}
          </p>
        </section>
      ) : null}

      {(role === 'ADMIN' || role === 'BILLING') && data.creditNotePending ? (
        <CreditNoteForm item={data} onSaved={() => { item.reload(); onChanged?.() }} />
      ) : null}
      {data.creditNote ? (
        <Notice kind="success">
          Nota crédito <strong>{data.creditNote.number}</strong> sobre la factura {data.order.invoiceNumber}
          {data.creditNote.by ? `, registrada por ${data.creditNote.by.name}` : ''} ({formatDateTime(data.creditNote.at)}).
        </Notice>
      ) : data.status === 'RECEIVED' && data.creditNotePending && role !== 'ADMIN' && role !== 'BILLING' ? (
        <p className="cell-sub">Orden facturada: facturación debe hacer la nota crédito.</p>
      ) : null}

      {(role === 'ADMIN' || role === 'SALES') && open ? (
        <section className="card">
          {answer?.kind === 'cancel' ? (
            <>
              <Field label="Motivo de la cancelación" hint="Por ejemplo, el cliente se quedó con el material.">
                <input value={answer.text} maxLength={500} autoFocus disabled={busy} onChange={(e) => setAnswer({ ...answer, text: e.target.value })} />
              </Field>
              <div className="actions">
                <button type="button" className="button button-danger" disabled={busy || answer.text.trim().length < 3} onClick={() => void act('cancel', answer.text)}>
                  Cancelar devolución
                </button>
                <button type="button" className="text-button" disabled={busy} onClick={() => setAnswer(null)}>
                  Volver
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="text-button danger" onClick={() => setAnswer({ kind: 'cancel', text: '' })}>
              Cancelar devolución…
            </button>
          )}
        </section>
      ) : null}
    </>
  )
}

// Reception in the warehouse: what came back of each line (good / damaged)
// and the chips of the bundles that come back closed, as they left.
function ReceiveForm({ item, onSaved }: { item: SalesReturn; onSaved: () => void }) {
  const { request } = useSession()
  const [counts, setCounts] = useState<Record<string, { good: string; damaged: string }>>(() =>
    Object.fromEntries(item.lines.map((line) => [line.id, { good: String(line.quantity), damaged: '0' }])),
  )
  const [sealed, setSealed] = useState<string[]>([])
  const [chip, setChip] = useState('')
  const [note, setNote] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef<string | null>(null)
  const inFlight = useRef(false)
  useUnsavedWork(sealed.length > 0 || note.trim() ? 'Recepción de devolución sin guardar' : null)

  const touch = () => {
    key.current = null
    setError(null)
  }
  // Closed bundles that may come back closed: left whole, nothing back yet.
  const closedSources = item.lines.flatMap((line) =>
    (line.sources ?? []).filter((s) => s.closed && s.returned === 0).map((s) => ({ ...s, lineId: line.id, lineNo: line.lineNo })),
  )
  const readChip = (event: FormEvent) => {
    event.preventDefault()
    const value = chip.trim().toUpperCase()
    setChip('')
    if (!value) return
    touch()
    if (sealed.includes(value)) {
      setNotice(`El chip ${value} ya está en la lista.`)
      return
    }
    const source = closedSources.find((s) => s.epc === value)
    if (!source) {
      const any = item.lines.some((line) => line.sources?.some((s) => s.epc === value))
      setNotice(
        any
          ? `El paquete ${value} salió abierto o ya volvió una parte: cuenta sus perfiles como sueltos, sin leer el chip.`
          : `El chip ${value} no salió en esta orden desde ${item.location.name}.`,
      )
      return
    }
    setNotice(null)
    setSealed([...sealed, value])
  }

  const parsed = item.lines.map((line) => {
    const c = counts[line.id] ?? { good: '', damaged: '' }
    const good = Number(c.good)
    const damaged = Number(c.damaged)
    const closed = closedSources.filter((s) => s.lineId === line.id && sealed.includes(s.epc)).reduce((t, s) => t + s.picked, 0)
    return { line, good, damaged, closed }
  })
  const total = parsed.reduce((t, p) => t + (Number.isInteger(p.good) ? p.good : 0) + (Number.isInteger(p.damaged) ? p.damaged : 0), 0)
  const bad = parsed.find(
    (p) => !Number.isInteger(p.good) || !Number.isInteger(p.damaged) || p.good < 0 || p.damaged < 0 || p.good + p.damaged > p.line.quantity,
  )
  const overClosed = parsed.find((p) => p.closed > p.good)
  const blocker = bad
    ? `renglón ${bad.line.lineNo}: buen estado + dañados, enteros, hasta ${bad.line.quantity}`
    : overClosed
      ? `renglón ${overClosed.line.lineNo}: los paquetes cerrados leídos suman ${overClosed.closed}, más que los ${overClosed.good} en buen estado`
      : total === 0
        ? 'no llegó nada: si el cliente no trajo el material, cancela la devolución'
        : null

  const save = async () => {
    if (inFlight.current || blocker) return
    inFlight.current = true
    key.current ??= uuid()
    setBusy(true)
    setError(null)
    try {
      await request(`/sales-returns/${encodeURIComponent(item.id)}/receive`, {
        method: 'POST',
        body: {
          operationKey: key.current,
          lines: parsed.map((p) => ({ lineId: p.line.id, good: p.good, damaged: p.damaged })),
          ...(sealed.length > 0 ? { sealedEpcs: sealed } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      })
      setSealed([])
      setNote('')
      onSaved()
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 0 || err.status >= 500))) key.current = null
      setError(describeError(err))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2 className="subtitle">Recibir en bodega</h2>
      <p className="field-hint">
        Cuenta lo que trajo el cliente. Lo que está en buen estado vuelve al inventario de {item.location.name}, a los paquetes de donde salió (con su origen);
        lo dañado queda registrado pero no vuelve al inventario.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Material</th>
              <th className="num">Esperados</th>
              <th className="num">Buen estado</th>
              <th className="num">Dañados</th>
            </tr>
          </thead>
          <tbody>
            {item.lines.map((line) => (
              <tr key={line.id}>
                <td data-label="#">{line.lineNo}</td>
                <td data-label="Material">
                  {line.referenceCode} · {line.finishDescription ?? line.finishCode}
                  {line.sources && line.sources.length > 0 ? (
                    <small className="cell-sub">
                      Salió de:{' '}
                      {line.sources
                        .map((s) => `${s.epc} (${profiles(s.picked)}${s.closed ? ', paquete cerrado' : ', sueltos'}${s.returned > 0 ? `; ya volvieron ${s.returned}` : ''})`)
                        .join(' · ')}
                    </small>
                  ) : null}
                </td>
                <td className="num" data-label="Esperados">{line.quantity}</td>
                {(['good', 'damaged'] as const).map((field) => (
                  <td key={field} className="num" data-label={field === 'good' ? 'Buen estado' : 'Dañados'}>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={line.quantity}
                      className="input-narrow"
                      aria-label={`${field === 'good' ? 'En buen estado' : 'Dañados'}, renglón ${line.lineNo}`}
                      value={counts[line.id]?.[field] ?? ''}
                      disabled={busy}
                      onChange={(e) => {
                        touch()
                        setCounts({ ...counts, [line.id]: { ...(counts[line.id] ?? { good: '', damaged: '' }), [field]: e.target.value } })
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {closedSources.length > 0 ? (
        <>
          <form className="lookup-form" onSubmit={readChip}>
            <Field
              label="Paquetes que vuelven cerrados (opcional)"
              hint="Si un paquete vuelve completo y sin abrir, lee su chip: queda cerrado, como salió. Lo demás se recibe como perfiles sueltos."
            >
              <span className="input-wrap">
                <IconScan />
                <input className="mono" autoComplete="off" spellCheck={false} value={chip} disabled={busy} onChange={(e) => setChip(e.target.value.toUpperCase())} />
              </span>
            </Field>
            <button type="submit" className="button button-secondary" disabled={busy || !chip.trim()}>
              Agregar
            </button>
          </form>
          {notice ? <Notice kind="info">{notice}</Notice> : null}
          {sealed.length > 0 ? (
            <ul className="doc-list">
              {sealed.map((epc) => {
                const source = closedSources.find((s) => s.epc === epc)!
                return (
                  <li key={epc} className="doc-row">
                    <span className="doc-main">
                      <strong className="mono">{epc}</strong>
                      <small>
                        Renglón {source.lineNo} · {profiles(source.picked)}, vuelve cerrado
                      </small>
                    </span>
                    <button type="button" className="text-button" disabled={busy} onClick={() => { touch(); setSealed(sealed.filter((s) => s !== epc)) }}>
                      Quitar
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </>
      ) : null}

      <Field label="Observación (opcional)">
        <input value={note} maxLength={500} disabled={busy} onChange={(e) => { touch(); setNote(e.target.value) }} />
      </Field>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="actions">
        <button type="button" className="button" disabled={busy || blocker !== null} onClick={() => void save()}>
          {busy ? 'Guardando…' : `Confirmar recepción (${profiles(total)})`}
        </button>
        {blocker && !busy ? <span className="cell-sub save-blocker">Para guardar: {blocker}</span> : null}
      </div>
    </section>
  )
}

// The money handed back to the customer (reintegro), once it is delivered.
function RefundForm({ item, onSaved }: { item: SalesReturn; onSaved: () => void }) {
  const { request } = useSession()
  const entities = useLoad<TransferEntity[]>('/transfer-entities')
  const [medium, setMedium] = useState<'CASH' | 'TRANSFER'>('CASH')
  const [entity, setEntity] = useState('')
  const [refundedOn, setRefundedOn] = useState(today())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blocker =
    medium === 'TRANSFER' && !entity
      ? 'elige desde qué entidad salió la transferencia'
      : !refundedOn
        ? 'elige la fecha'
        : refundedOn > today()
          ? 'la fecha no puede ser posterior a hoy'
          : null

  const save = async () => {
    if (busy || blocker) return
    setBusy(true)
    setError(null)
    try {
      await request(`/sales-returns/${encodeURIComponent(item.id)}/refund`, {
        method: 'POST',
        body: { medium, ...(medium === 'TRANSFER' ? { transferEntityId: entity } : {}), refundedOn, ...(note.trim() ? { note: note.trim() } : {}) },
      })
      onSaved()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2 className="subtitle">Reintegro pendiente: {formatMoney(item.settledAmount ?? '0')}</h2>
      <p className="field-hint">Regístralo cuando le entregues el dinero al cliente.</p>
      <div className="form-grid">
        <Field label="Medio">
          <select value={medium} disabled={busy} onChange={(e) => setMedium(e.target.value as 'CASH' | 'TRANSFER')}>
            <option value="CASH">Efectivo</option>
            <option value="TRANSFER">Transferencia</option>
          </select>
        </Field>
        {medium === 'TRANSFER' ? (
          <Field label="¿Desde dónde salió la transferencia?" hint="La entidad de Solaluminios.">
            <select value={entity} disabled={busy} onChange={(e) => setEntity(e.target.value)}>
              <option value="">{ENTITY_PLACEHOLDER}</option>
              {(entities.data ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Fecha">
          <input type="date" value={refundedOn} max={today()} disabled={busy} onChange={(e) => setRefundedOn(e.target.value)} />
        </Field>
        <Field label="Observación (opcional)">
          <input value={note} maxLength={300} disabled={busy} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="actions">
        <button type="button" className="button" disabled={busy || blocker !== null} onClick={() => void save()}>
          {busy ? 'Guardando…' : 'Registrar reintegro'}
        </button>
        {blocker && !busy ? <span className="cell-sub save-blocker">Para guardar: {blocker}</span> : null}
      </div>
    </section>
  )
}

// Number of the credit note made in the billing software.
function CreditNoteForm({ item, onSaved }: { item: SalesReturn; onSaved: () => void }) {
  const { request } = useSession()
  const [number, setNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useUnsavedWork(number.trim() ? 'Número de nota crédito sin registrar' : null)

  const save = async () => {
    if (busy || !number.trim()) return
    setBusy(true)
    setError(null)
    try {
      await request(`/sales-returns/${encodeURIComponent(item.id)}/credit-note`, { method: 'POST', body: { number: number.trim() } })
      setNumber('')
      onSaved()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card billing-card">
      <h2 className="subtitle">Nota crédito</h2>
      <p className="field-hint">
        La orden {item.order.number} está facturada ({item.order.invoiceNumber}). Haz la nota crédito por {formatMoney(item.amount ?? '0')} en el software de
        facturación y registra aquí su número.
      </p>
      <Field label="Número de la nota crédito">
        <input value={number} maxLength={60} disabled={busy} onChange={(e) => setNumber(e.target.value)} />
      </Field>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="actions">
        <button type="button" className="button" disabled={busy || !number.trim()} onClick={() => void save()}>
          {busy ? 'Guardando…' : 'Registrar nota crédito'}
        </button>
      </div>
    </section>
  )
}
