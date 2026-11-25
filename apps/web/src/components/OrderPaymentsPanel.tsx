import { useRef, useState } from 'react'
import { ApiError, describeError } from '../api/client'
import {
  CONTADO_METHODS,
  ENTITY_PLACEHOLDER,
  ENTITY_QUESTION,
  ENTITY_UNKNOWN,
  PAYMENT_MEDIUM_LABEL,
  formatMoney,
  type OrderPayment,
  type PaymentMedium,
  type SalesOrder,
  type TransferEntity,
} from '../lib/commerce'
import { formatDateTime } from '../lib/format'
import { parseMoney } from '../lib/numbers'
import { useLoad } from '../lib/useLoad'
import { uuid } from '../lib/uuid'
import { useSession } from '../session/session-context'
import { Field, Kpi, Notice } from './ui'

// Payments of an order in one place: total, paid, balance and history. The
// user only types what was just received; the API adds it up and computes the
// balance. «Agregar abono» records a new payment (abono / cartera orders);
// «Editar» corrects one already recorded (never adds another payment).

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date())
const cents = (value: string) => {
  const text = parseMoney(value)
  return /^\d{1,12}(\.\d{1,2})?$/.test(text) ? Math.round(Number(text) * 100) : null
}
const asCents = (value: string) => Math.round(Number(value) * 100)
// Cents as people type them: «3453» or «3453,11» (read back by parseMoney).
const typedPesos = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace('.', ','))
const dayLabel = (value: string) => {
  const [y, m, d] = value.split('-')
  return `${d}/${m}/${y}`
}
const FIELD_LABEL: Record<string, string> = { amount: 'Valor', medium: 'Medio', transferEntityId: 'Entidad', paidOn: 'Fecha', note: 'Observación' }
const describeValue = (field: string, value: string | null, entityNames: Map<string, string>) =>
  field === 'transferEntityId'
    ? value === null
      ? '(sin entidad)'
      : entityNames.get(value) ?? value
    : value === null || value === ''
    ? '(vacío)'
    : field === 'amount'
      ? formatMoney(value)
      : field === 'medium'
        ? PAYMENT_MEDIUM_LABEL[value as PaymentMedium] ?? value
        : field === 'paidOn'
          ? dayLabel(value)
          : `«${value}»`

interface Draft {
  amount: string
  paidOn: string
  medium: PaymentMedium
  // Transfer: id of the entity where it was received ('' = not chosen yet).
  entity: string
  note: string
}

export function OrderPaymentsPanel({ order, canRecord, onChanged }: { order: SalesOrder; canRecord: boolean; onChanged: () => void }) {
  const summary = order.paymentSummary
  const payments = order.payments ?? []
  const [adding, setAdding] = useState<Draft | null>(null)
  const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null)
  const entities = useLoad<TransferEntity[]>(canRecord && summary ? '/transfer-entities' : null)
  if (!summary) return null
  // Names of the entities: the list plus the ones already saved on payments.
  const entityNames = new Map<string, string>([
    ...payments.flatMap((p) => (p.transferEntity ? [[p.transferEntity.id, p.transferEntity.name] as [string, string]] : [])),
    ...(entities.data ?? []).map((e) => [e.id, e.name] as [string, string]),
  ])

  const contado = order.paymentMethod !== null && CONTADO_METHODS.includes(order.paymentMethod)
  const collectedLater = order.paymentMethod === 'PARTIAL' || order.paymentMethod === 'CREDIT'
  const cancelled = order.status === 'CANCELLED'
  const balanceCents = asCents(summary.balance)
  // Abono / cartera marked paid by hand before abonos existed: its abonos are
  // recorded only after putting it back to pending.
  const paidByHand = !summary.recorded && order.paymentStatus === 'PAID'
  const canAdd = canRecord && collectedLater && !cancelled && balanceCents > 0 && !paidByHand
  // Returns: the net total is what the order is worth now; what was given
  // back to the customer (saldo a favor / reintegro) no longer counts as paid.
  const returnedCents = asCents(summary.returned ?? '0')
  const settledCents = asCents(summary.settled ?? '0')
  const creditCents = asCents(order.customerCredit ?? '0')

  return (
    <section className="card order-payments">
      <div className="payments-head">
        <h2 className="subtitle">Pagos</h2>
        {canAdd && !adding ? (
          <button
            type="button"
            className="button"
            onClick={() => {
              setEditing(null)
              setAdding({ amount: '', paidOn: today(), medium: 'CASH', entity: '', note: '' })
            }}
          >
            Agregar abono
          </button>
        ) : null}
      </div>

      {contado && !summary.recorded ? (
        <Notice kind="info">
          Orden de contado anterior al registro de pagos: se toma como pagada al vender, sin detalle de efectivo o transferencia.
        </Notice>
      ) : null}
      {paidByHand ? (
        <Notice kind="info">
          La orden se marcó como pagada a mano, antes de que existieran los abonos, y no tiene abonos registrados.
          {canRecord && !cancelled ? ' Para registrar sus abonos, vuélvela primero a «Pago pendiente».' : ''}
        </Notice>
      ) : null}

      {contado && !summary.recorded ? null : (
        <div className="kpis">
          <Kpi label="Total de la orden" value={formatMoney(summary.total)} hint={returnedCents > 0 ? `Devuelto ${formatMoney(returnedCents / 100)}` : undefined} />
          {returnedCents > 0 ? <Kpi label="Total neto" value={formatMoney(summary.net)} hint="Después de devoluciones" /> : null}
          <Kpi
            label={contado ? 'Pagado' : 'Total abonado'}
            value={formatMoney(summary.paid)}
            hint={`${payments.length} ${payments.length === 1 ? 'pago' : 'pagos'}${settledCents > 0 ? ` · ${formatMoney(settledCents / 100)} devueltos al cliente` : ''}`}
          />
          <Kpi
            label="Saldo pendiente"
            value={formatMoney(summary.balance)}
            hint={summary.complete ? 'Pago completo' : paidByHand ? 'Marcada pagada a mano' : 'Por pagar'}
            dark={!summary.complete && !paidByHand}
          />
        </div>
      )}
      {summary.complete ? <p className="payment-complete"><span className="badge badge-paid">Pago completo</span></p> : null}
      {canRecord && creditCents > 0 ? (
        <p className="cell-sub">
          El cliente tiene <strong>{formatMoney(creditCents / 100)}</strong> de saldo a favor (de devoluciones)
          {canAdd ? ': puedes usarlo en «Agregar abono» con el medio «Saldo a favor».' : '.'}
        </p>
      ) : null}

      {adding ? (
        <PaymentForm
          key="new"
          title="Agregar abono"
          order={order}
          initial={adding}
          entities={entities.data ?? null}
          room={balanceCents}
          credit={creditCents}
          lockAmount={false}
          onCancel={() => setAdding(null)}
          onSaved={() => {
            setAdding(null)
            onChanged()
          }}
        />
      ) : null}

      {payments.length > 0 ? (
        <div className="table-wrap">
          <table className="payments-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Medio</th>
                <th className="num">Valor</th>
                <th>Observación</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) =>
                editing?.id === payment.id ? (
                  <tr key={payment.id}>
                    <td colSpan={5}>
                      <PaymentForm
                        key={payment.id}
                        title={`Editar ${payment.atSale ? 'pago de contado' : 'abono'} del ${dayLabel(payment.paidOn)}`}
                        order={order}
                        payment={payment}
                        initial={editing.draft}
                        entities={entities.data ?? null}
                        room={balanceCents + asCents(payment.amount)}
                        credit={creditCents + (payment.medium === 'CREDIT_BALANCE' ? asCents(payment.amount) : 0)}
                        lockAmount={payment.atSale}
                        onCancel={() => setEditing(null)}
                        onSaved={() => {
                          setEditing(null)
                          onChanged()
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={payment.id}>
                    <td data-label="Fecha">
                      {dayLabel(payment.paidOn)}
                      {payment.atSale ? <small className="cell-sub">Contado, al vender</small> : null}
                      {payment.medium === 'CREDIT_BALANCE' ? <small className="cell-sub">De devoluciones anteriores</small> : null}
                    </td>
                    <td data-label="Medio">
                      {PAYMENT_MEDIUM_LABEL[payment.medium]}
                      {payment.medium === 'TRANSFER' ? <small className="cell-sub">{payment.transferEntity?.name ?? ENTITY_UNKNOWN}</small> : null}
                    </td>
                    <td className="num" data-label="Valor">{formatMoney(payment.amount)}</td>
                    <td data-label="Observación">
                      {payment.note ?? <span className="cell-sub">—</span>}
                      {payment.createdBy ? <small className="cell-sub">Registró {payment.createdBy.name} · {formatDateTime(payment.createdAt)}</small> : null}
                      {payment.changes.map((change, index) => (
                        <small key={index} className="cell-sub payment-change">
                          Corregido {formatDateTime(change.at)}
                          {change.by ? ` por ${change.by.name}` : ''}:{' '}
                          {Object.entries(change.changed)
                            .map(([field, values]) => `${FIELD_LABEL[field] ?? field} ${describeValue(field, values.from, entityNames)} → ${describeValue(field, values.to, entityNames)}`)
                            .join(' · ')}
                        </small>
                      ))}
                    </td>
                    <td className="num">
                      {canRecord && !cancelled ? (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            setAdding(null)
                            setEditing({
                              id: payment.id,
                              draft: {
                                amount: String(Number(payment.amount)),
                                paidOn: payment.paidOn,
                                medium: payment.medium,
                                entity: payment.transferEntity?.id ?? '',
                                note: payment.note ?? '',
                              },
                            })
                          }}
                        >
                          Editar
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : collectedLater && !paidByHand ? (
        <p className="cell-sub">Todavía no hay abonos registrados.</p>
      ) : null}
    </section>
  )
}

// New abono or correction of a payment. `room`: the most this payment may be
// (the balance, plus its own current amount when editing). `credit`: the
// customer's saldo a favor available to this payment.
function PaymentForm({
  title,
  order,
  payment,
  initial,
  entities,
  room,
  credit,
  lockAmount,
  onCancel,
  onSaved,
}: {
  title: string
  order: SalesOrder
  payment?: OrderPayment
  initial: Draft
  entities: TransferEntity[] | null
  room: number
  credit: number
  lockAmount: boolean
  onCancel: () => void
  onSaved: () => void
}) {
  const { request } = useSession()
  const [draft, setDraft] = useState<Draft>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef<string | null>(null)
  const inFlight = useRef(false)

  // A transfer recorded before the entity was asked may stay «Sin
  // especificar» while it remains a transfer; any other transfer needs one.
  const unknownAllowed = payment?.medium === 'TRANSFER' && !payment.transferEntity
  const amountCents = cents(draft.amount)
  const after = amountCents === null ? null : room - amountCents
  const problem =
    amountCents === null
      ? 'escribe el valor recibido'
      : amountCents <= 0
        ? 'el valor debe ser mayor que cero'
        : amountCents > room
          ? `el valor supera el saldo (${formatMoney(room / 100)})`
          : draft.medium === 'CREDIT_BALANCE' && amountCents > credit
            ? credit > 0
              ? `el cliente tiene ${formatMoney(credit / 100)} de saldo a favor`
              : 'el cliente no tiene saldo a favor'
          : draft.medium === 'TRANSFER' && !draft.entity && !unknownAllowed
            ? 'selecciona dónde se recibió la transferencia'
          : !draft.paidOn
            ? 'elige la fecha del pago'
            : draft.paidOn > today()
              ? 'la fecha no puede ser posterior a hoy'
              : null

  const change = (patch: Partial<Draft>) => {
    // Different data is a different abono: new key. A retry keeps the key.
    key.current = null
    setError(null)
    setDraft((current) => ({ ...current, ...patch }))
  }

  const save = async () => {
    if (inFlight.current || problem) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    const amount = parseMoney(draft.amount)
    try {
      if (payment) {
        const body: Record<string, string | null> = {}
        if (!lockAmount && cents(amount) !== Math.round(Number(payment.amount) * 100)) body.amount = amount
        if (draft.medium !== payment.medium) body.medium = draft.medium
        if (draft.medium === 'TRANSFER' && draft.entity && draft.entity !== (payment.transferEntity?.id ?? '')) body.transferEntityId = draft.entity
        if (draft.paidOn !== payment.paidOn) body.paidOn = draft.paidOn
        if (draft.note.trim() !== (payment.note ?? '')) body.note = draft.note.trim() || null
        if (Object.keys(body).length > 0) {
          await request(`/sales-orders/${encodeURIComponent(order.id)}/payments/${encodeURIComponent(payment.id)}`, { method: 'PATCH', body })
        }
      } else {
        key.current ??= uuid()
        await request(`/sales-orders/${encodeURIComponent(order.id)}/payments`, {
          method: 'POST',
          body: {
            operationKey: key.current,
            amount,
            medium: draft.medium,
            ...(draft.medium === 'TRANSFER' ? { transferEntityId: draft.entity } : {}),
            paidOn: draft.paidOn,
            ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
          },
        })
      }
      onSaved()
    } catch (err) {
      // Lost answer: keep the key, the retry returns the same abono.
      if (!(err instanceof ApiError && (err.status === 0 || err.status >= 500))) key.current = null
      setError(describeError(err))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="payment-form" role="group" aria-label={title}>
      <p>
        <strong>{title}</strong>
      </p>
      <div className="form-grid">
        <Field
          label={payment ? 'Valor correcto de este pago' : 'Valor recibido'}
          hint={
            lockAmount
              ? 'El valor de un pago de contado no se cambia: el contado suma el total de la orden.'
              : payment
                ? `Reemplaza el valor anterior (no se suma como otro pago). Máximo: ${formatMoney(room / 100)}.`
                : `Solo lo que se acaba de recibir. Saldo disponible: ${formatMoney(room / 100)}.`
          }
        >
          <input inputMode="decimal" autoFocus={!lockAmount} value={draft.amount} disabled={busy || lockAmount} onChange={(e) => change({ amount: e.target.value })} />
          {!payment && room > 0 && amountCents !== room ? (
            // The whole balance, cents included, without typing them.
            <button type="button" className="text-button" disabled={busy} onClick={() => change({ amount: typedPesos(room) })}>
              Pagar todo el saldo: {formatMoney(room / 100)}
            </button>
          ) : null}
        </Field>
        <Field label="Fecha del pago">
          <input type="date" value={draft.paidOn} max={today()} disabled={busy} onChange={(e) => change({ paidOn: e.target.value })} />
        </Field>
        <Field label="Medio de pago">
          <select
            value={draft.medium}
            disabled={busy}
            // Cash never keeps an entity; a payment that becomes a transfer
            // starts without one (a transfer kept as such keeps its own).
            onChange={(e) =>
              change({
                medium: e.target.value as PaymentMedium,
                entity: e.target.value === 'TRANSFER' && payment?.medium === 'TRANSFER' ? (payment.transferEntity?.id ?? '') : '',
              })
            }
          >
            {(Object.keys(PAYMENT_MEDIUM_LABEL) as PaymentMedium[]).filter((medium) => medium !== 'CREDIT_BALANCE' || credit > 0 || draft.medium === medium).map((medium) => (
              <option key={medium} value={medium}>
                {PAYMENT_MEDIUM_LABEL[medium]}
              </option>
            ))}
          </select>
        </Field>
        {draft.medium === 'TRANSFER' ? (
          <Field label={ENTITY_QUESTION} hint="La entidad de Solaluminios que recibió el dinero (no la del cliente).">
            <select required value={draft.entity} disabled={busy} onChange={(e) => change({ entity: e.target.value })}>
              <option value="">{unknownAllowed ? ENTITY_UNKNOWN + ' (sin cambiar)' : ENTITY_PLACEHOLDER}</option>
              {(entities ?? []).map((entity) => (
                <option key={entity.id} value={entity.id}>
                  {entity.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Observación (opcional)">
          <input value={draft.note} maxLength={300} disabled={busy} onChange={(e) => change({ note: e.target.value })} />
        </Field>
      </div>
      {after !== null && after >= 0 && !lockAmount ? (
        <p className="cell-sub" aria-live="polite">
          Saldo pendiente después de guardar: <strong>{formatMoney(after / 100)}</strong>
          {after === 0 ? ' · la orden queda pagada' : ''}
        </p>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="actions">
        <button type="button" className="button" disabled={busy || problem !== null} onClick={() => void save()}>
          {busy ? 'Guardando…' : payment ? 'Guardar corrección' : 'Guardar abono'}
        </button>
        <button type="button" className="text-button" disabled={busy} onClick={onCancel}>
          Cancelar
        </button>
        {problem && !busy ? <span className="cell-sub save-blocker">Para guardar: {problem}</span> : null}
      </div>
    </div>
  )
}
