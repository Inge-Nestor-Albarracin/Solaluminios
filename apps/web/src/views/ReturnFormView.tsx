import { useRef, useState } from 'react'
import { ApiError, describeError } from '../api/client'
import { Field, Loading, Notice, PageHeader } from '../components/ui'
import { ORIGIN_LABEL, formatMoney } from '../lib/commerce'
import {
  RETURN_REASONS,
  SETTLEMENTS,
  estimateLine,
  profiles,
  type Returnable,
  type ReturnReason,
  type ReturnSettlement,
  type SalesReturn,
} from '../lib/returns'
import { useLoad } from '../lib/useLoad'
import { uuid } from '../lib/uuid'
import { useUnsavedWork } from '../pwa/workGuard'
import { useSession } from '../session/session-context'
import type { Navigate } from './navigation'

// «Registrar devolución» of a sales order: how many delivered profiles of
// each line come back, why, and what happens with the money. A seller's
// request goes to the administrator it chooses; an administrator's is
// approved at once. The warehouse receives it afterwards (its own task).
export function ReturnFormView({ orderId, navigate }: { orderId: string; navigate: Navigate }) {
  const { request, user } = useSession()
  const admin = user?.role === 'ADMIN'
  const data = useLoad<Returnable>(`/sales-orders/${encodeURIComponent(orderId)}/returnable`)
  const approvers = useLoad<{ id: string; name: string }[]>(admin ? null : '/sales/discount-approvers')
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [reason, setReason] = useState<ReturnReason | ''>('')
  const [settlement, setSettlement] = useState<ReturnSettlement>('CREDIT')
  const [notes, setNotes] = useState('')
  const [approverId, setApproverId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef<string | null>(null)
  const inFlight = useRef(false)

  const chosen = Object.values(quantities).some((q) => q.trim() !== '')
  useUnsavedWork(chosen ? 'Devolución sin registrar' : null)

  if (data.loading && !data.data) return <Loading />
  if (data.error && !data.data) return <Notice kind="error">{data.error}</Notice>
  if (!data.data) return null
  const info = data.data

  const touch = () => {
    key.current = null
    setError(null)
  }
  const parsed = info.lines.map((line) => {
    const text = (quantities[line.id] ?? '').trim()
    return { line, text, n: text === '' ? 0 : Number(text) }
  })
  const chosenLines = parsed.filter((p) => p.text !== '' && p.n !== 0)
  const estimate = chosenLines.reduce((total, p) => total + (Number.isInteger(p.n) && p.n > 0 ? estimateLine(p.line, p.n) : 0), 0)
  const nothingLeft = info.lines.every((line) => line.returnable === 0)
  const count = chosenLines.reduce((total, p) => total + (Number.isInteger(p.n) && p.n > 0 ? p.n : 0), 0)
  const invalid = parsed.find((p) => p.text !== '' && (!Number.isInteger(p.n) || p.n < 0 || p.n > p.line.returnable))
  const blocker = info.problem
    ? 'esta orden no admite devoluciones'
    : nothingLeft
      ? 'no queda nada por devolver'
      : invalid
      ? `renglón ${invalid.line.lineNo}: escribe un número entero entre 0 y ${invalid.line.returnable}`
      : chosenLines.length === 0
        ? 'escribe cuántos perfiles devuelve al menos un renglón'
        : !reason
          ? 'elige el motivo'
          : !admin && !approverId
            ? 'elige el administrador que autoriza'
            : null

  const save = async () => {
    if (inFlight.current || blocker) return
    inFlight.current = true
    key.current ??= uuid()
    setBusy(true)
    setError(null)
    try {
      const { data: created } = await request<SalesReturn>(`/sales-orders/${encodeURIComponent(orderId)}/returns`, {
        method: 'POST',
        body: {
          operationKey: key.current,
          reason,
          settlement,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(admin ? {} : { approverId }),
          lines: chosenLines.map((p) => ({ salesOrderLineId: p.line.id, quantity: p.n })),
        },
      })
      setQuantities({})
      navigate({ name: 'return', id: created.id })
    } catch (err) {
      // Lost answer: keep the key, the retry returns the same return.
      if (!(err instanceof ApiError && (err.status === 0 || err.status >= 500))) key.current = null
      setError(describeError(err))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const credit = Number(info.customerCredit)

  return (
    <>
      <PageHeader
        eyebrow={`Ventas · Orden ${info.order.number}`}
        title="Registrar devolución"
        description={`${info.order.customer.name}. Solo se devuelve lo ya entregado. ${
          admin ? 'Como administrador, queda autorizada al guardar.' : 'La autoriza el administrador que elijas.'
        } Después, bodega la recibe y cuenta lo que llega.`}
        actions={
          <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'order', id: orderId })}>
            Volver a la orden
          </button>
        }
      />
      {info.problem ? <Notice kind="warning">{info.problem}</Notice> : null}
      {!info.problem && nothingLeft ? (
        <Notice kind="info">
          No queda nada por devolver en esta orden: lo entregado ya se devolvió o está en una devolución en trámite (míralas en la orden).
        </Notice>
      ) : null}
      {info.order.billed ? (
        <Notice kind="info">
          La orden está facturada ({info.order.invoiceNumber}): al recibir la devolución, facturación recibe una tarea para hacer la nota crédito.
        </Notice>
      ) : null}

      <section className="card">
        <h2 className="subtitle">¿Qué devuelve el cliente?</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Material</th>
                <th>Origen</th>
                <th className="num">Entregado</th>
                <th className="num">Ya devuelto o en trámite</th>
                <th className="num">Devuelve ahora</th>
              </tr>
            </thead>
            <tbody>
              {info.lines.map((line) => (
                <tr key={line.id}>
                  <td data-label="#">{line.lineNo}</td>
                  <td data-label="Material">
                    {line.referenceCode} · {line.finishDescription ?? line.finishCode}
                    {line.referenceDescription ? <small className="cell-sub">{line.referenceDescription}</small> : null}
                  </td>
                  <td data-label="Origen">{ORIGIN_LABEL[line.origin]}</td>
                  <td className="num" data-label="Entregado">
                    {line.delivered} de {line.quantity}
                  </td>
                  <td className="num" data-label="Ya devuelto o en trámite">
                    {line.returned + line.inProcess}
                  </td>
                  <td className="num" data-label="Devuelve ahora">
                    {line.returnable > 0 ? (
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={line.returnable}
                        className="input-narrow"
                        aria-label={`Perfiles que devuelve del renglón ${line.lineNo}`}
                        placeholder={`hasta ${line.returnable}`}
                        value={quantities[line.id] ?? ''}
                        disabled={busy}
                        onChange={(e) => {
                          touch()
                          setQuantities({ ...quantities, [line.id]: e.target.value })
                        }}
                      />
                    ) : (
                      <span className="cell-sub">{line.delivered === 0 ? 'Sin entregar' : 'Nada por devolver'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {count > 0 ? (
          <p className="quote-totals" aria-live="polite">
            {profiles(count)} · valor aproximado <strong>{formatMoney(estimate)}</strong> (con IVA, proporcional a cada renglón; se calcula exacto al recibir)
          </p>
        ) : null}
      </section>

      <section className="card">
        <div className="form-grid">
          <Field label="Motivo">
            <select value={reason} disabled={busy} onChange={(e) => { touch(); setReason(e.target.value as ReturnReason) }}>
              <option value="">Elige el motivo…</option>
              {RETURN_REASONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Dinero ya pagado de más" hint={SETTLEMENTS.find((s) => s.id === settlement)?.hint}>
            <select value={settlement} disabled={busy} onChange={(e) => { touch(); setSettlement(e.target.value as ReturnSettlement) }}>
              {SETTLEMENTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          {admin ? null : (
            <Field label="Administrador que autoriza">
              <select value={approverId} disabled={busy} onChange={(e) => { touch(); setApproverId(e.target.value) }}>
                <option value="">Elige…</option>
                {(approvers.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              {approvers.error ? <span className="field-error">{approvers.error}</span> : null}
            </Field>
          )}
          <Field label="Observación (opcional)">
            <input value={notes} maxLength={500} disabled={busy} onChange={(e) => { touch(); setNotes(e.target.value) }} />
          </Field>
        </div>
        <p className="field-hint">
          El valor devuelto primero descuenta lo que el cliente aún debe de esta orden; solo lo que ya había pagado de más va a{' '}
          {settlement === 'CREDIT' ? 'saldo a favor' : 'reintegro'}.
          {credit > 0 ? ` Hoy el cliente tiene ${formatMoney(credit)} de saldo a favor.` : ''}
        </p>
        {error ? <Notice kind="error">{error}</Notice> : null}
        <div className="actions">
          <button type="button" className="button" disabled={busy || blocker !== null} onClick={() => void save()}>
            {busy ? 'Guardando…' : admin ? 'Registrar y autorizar' : 'Enviar para autorizar'}
          </button>
          {blocker && !busy ? <span className="cell-sub save-blocker">Para guardar: {blocker}</span> : null}
        </div>
      </section>
    </>
  )
}
