import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, describeError } from '../api/client'
import type { BundleDetail, OperationResult } from '../api/types'
import { canAdjust, canOperate, useSession } from '../session/session-context'
import { EMPTY_LOCATION, type LocationValue } from '../lib/forms'
import { uuid } from '../lib/uuid'
import { LocationSelectors } from './LocationSelectors'
import { Field, Notice } from './ui'

type Action = 'exit' | 'transfer' | 'adjustments'

const REPLAYED = 'La operación ya estaba registrada; no se modificó el inventario otra vez.'

// One operationKey per intended operation. It is kept while the request is
// retried after a network or server error, so the API never applies it twice,
// and discarded once the data changes, the API rejects it, or it succeeds.
function useOperation(bundleId: string, onDone: (message: string) => void) {
  const { request } = useSession()
  const key = useRef<string | null>(null)
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = useCallback(() => {
    key.current = null
    setError(null)
  }, [])

  const run = async (action: Action, body: Record<string, unknown>, success: (r: OperationResult) => string) => {
    // The ref blocks a second click before React re-renders with pending.
    if (inFlight.current) return false
    inFlight.current = true
    key.current ??= uuid()
    setPending(true)
    setError(null)
    try {
      const { data } = await request<OperationResult>(`/inventory/bundles/${encodeURIComponent(bundleId)}/${action}`, {
        method: 'POST',
        body: { ...body, operationKey: key.current },
      })
      key.current = null
      onDone(data.replayed ? REPLAYED : success(data))
      return true
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) key.current = null
      setError(
        err instanceof ApiError && (err.status === 0 || err.status >= 500)
          ? `${describeError(err)} Puedes reintentar: la operación no se aplicará dos veces.`
          : describeError(err),
      )
      return false
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return { pending, error, reset, run }
}

function Confirm({
  children,
  pending,
  confirmLabel,
  onBack,
}: {
  children: ReactNode
  pending: boolean
  confirmLabel: string
  onBack: () => void
}) {
  return (
    <div className="confirm" role="alertdialog" aria-label="Confirmar operación">
      <div>{children}</div>
      <div className="actions">
        <button type="submit" className="button button-danger" disabled={pending}>
          {pending ? 'Procesando…' : confirmLabel}
        </button>
        <button type="button" className="button button-secondary" disabled={pending} onClick={onBack}>
          Volver
        </button>
      </div>
    </div>
  )
}

function ExitForm({ bundle, onDone }: { bundle: BundleDetail; onDone: (message: string) => void }) {
  const op = useOperation(bundle.id, onDone)
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const amount = Number(quantity)
  const valid = Number.isInteger(amount) && amount >= 1 && amount <= bundle.quantity

  const edit = (apply: () => void) => {
    apply()
    setConfirming(false)
    op.reset()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!confirming) return setConfirming(valid)
    const ok = await op.run('exit', { quantity: amount, reason: reason.trim() || undefined }, (r) =>
      `Salida registrada: ${r.movement.quantity} perfiles. Saldo actual: ${r.bundle.quantity}.`,
    )
    if (ok) {
      setQuantity('')
      setReason('')
      setConfirming(false)
    }
  }

  return (
    <form className="form-grid" onSubmit={submit}>
      {op.error ? <div className="field-wide"><Notice kind="error">{op.error}</Notice></div> : null}
      <Field label="Perfiles que salen" hint={`Saldo disponible: ${bundle.quantity}.`}>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={bundle.quantity}
          step={1}
          required
          disabled={op.pending}
          value={quantity}
          onChange={(e) => edit(() => setQuantity(e.target.value))}
        />
      </Field>
      <Field label="Motivo o documento (opcional)">
        <input type="text" maxLength={500} disabled={op.pending} value={reason} onChange={(e) => edit(() => setReason(e.target.value))} />
      </Field>
      <div className="field-wide">
        {confirming ? (
          <Confirm pending={op.pending} confirmLabel="Confirmar salida" onBack={() => edit(() => undefined)}>
            Se descontarán <strong>{amount}</strong> perfiles del paquete <span className="mono">{bundle.epc}</span>. Saldo:{' '}
            {bundle.quantity} → <strong>{bundle.quantity - amount}</strong>.
          </Confirm>
        ) : (
          <button type="submit" className="button" disabled={!valid}>
            Revisar salida
          </button>
        )}
      </div>
    </form>
  )
}

function TransferForm({ bundle, onDone }: { bundle: BundleDetail; onDone: (message: string) => void }) {
  const op = useOperation(bundle.id, onDone)
  const [location, setLocation] = useState<LocationValue>(EMPTY_LOCATION)
  const [description, setDescription] = useState('')
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const sameRack = location.rackId === bundle.rackId && location.inventoryLocationId === bundle.inventoryLocationId
  const valid = !!location.rackId && !sameRack

  const edit = (apply: () => void) => {
    apply()
    setConfirming(false)
    op.reset()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!confirming) return setConfirming(valid)
    const ok = await op.run(
      'transfer',
      { inventoryLocationId: location.inventoryLocationId, rackId: location.rackId, reason: reason.trim() || undefined },
      () => `Paquete trasladado a ${description}.`,
    )
    if (ok) {
      setLocation(EMPTY_LOCATION)
      setReason('')
      setConfirming(false)
    }
  }

  return (
    <form className="form-grid" onSubmit={submit}>
      {op.error ? <div className="field-wide"><Notice kind="error">{op.error}</Notice></div> : null}
      <p className="field-wide muted">Se traslada el paquete completo; la cantidad no cambia.</p>
      <LocationSelectors
        mode="form"
        value={location}
        disabled={op.pending}
        onChange={(value) => edit(() => setLocation(value))}
        onDescribe={setDescription}
        labels={{ location: 'Bodega destino', rack: 'Burro destino' }}
      />
      <Field label="Motivo (opcional)">
        <input type="text" maxLength={500} disabled={op.pending} value={reason} onChange={(e) => edit(() => setReason(e.target.value))} />
      </Field>
      {sameRack ? (
        <div className="field-wide"><Notice kind="warning">El paquete ya está en ese burro.</Notice></div>
      ) : null}
      <div className="field-wide">
        {confirming ? (
          <Confirm pending={op.pending} confirmLabel="Confirmar traslado" onBack={() => edit(() => undefined)}>
            Se trasladará el paquete <span className="mono">{bundle.epc}</span> completo ({bundle.quantity} perfiles) a{' '}
            <strong>{description}</strong>.
          </Confirm>
        ) : (
          <button type="submit" className="button" disabled={!valid}>
            Revisar traslado
          </button>
        )}
      </div>
    </form>
  )
}

function AdjustmentForm({ bundle, onDone }: { bundle: BundleDetail; onDone: (message: string) => void }) {
  const op = useOperation(bundle.id, onDone)
  const [type, setType] = useState<'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT'>('ADJUSTMENT_IN')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const amount = Number(quantity)
  const incoming = type === 'ADJUSTMENT_IN'
  const valid =
    Number.isInteger(amount) && amount >= 1 && (incoming || amount <= bundle.quantity) && reason.trim() !== ''
  const after = incoming ? bundle.quantity + amount : bundle.quantity - amount

  const edit = (apply: () => void) => {
    apply()
    setConfirming(false)
    op.reset()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!confirming) return setConfirming(valid)
    const ok = await op.run('adjustments', { type, quantity: amount, reason: reason.trim() }, (r) =>
      `Ajuste registrado. Saldo actual: ${r.bundle.quantity}.`,
    )
    if (ok) {
      setQuantity('')
      setReason('')
      setConfirming(false)
    }
  }

  return (
    <form className="form-grid" onSubmit={submit}>
      {op.error ? <div className="field-wide"><Notice kind="error">{op.error}</Notice></div> : null}
      <Field label="Tipo de ajuste">
        <select value={type} disabled={op.pending} onChange={(e) => edit(() => setType(e.target.value as typeof type))}>
          <option value="ADJUSTMENT_IN">Aumentar perfiles</option>
          <option value="ADJUSTMENT_OUT">Disminuir perfiles</option>
        </select>
      </Field>
      <Field label="Perfiles" hint={incoming ? undefined : `Máximo ${bundle.quantity}.`}>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={incoming ? undefined : bundle.quantity}
          step={1}
          required
          disabled={op.pending}
          value={quantity}
          onChange={(e) => edit(() => setQuantity(e.target.value))}
        />
      </Field>
      <Field label="Motivo (obligatorio)" wide>
        <input type="text" required maxLength={500} disabled={op.pending} value={reason} onChange={(e) => edit(() => setReason(e.target.value))} />
      </Field>
      <div className="field-wide">
        {confirming ? (
          <Confirm pending={op.pending} confirmLabel="Confirmar ajuste" onBack={() => edit(() => undefined)}>
            Ajuste {incoming ? 'positivo' : 'negativo'} de <strong>{amount}</strong> perfiles. Saldo: {bundle.quantity} →{' '}
            <strong>{after}</strong>. Motivo: {reason.trim()}.
          </Confirm>
        ) : (
          <button type="submit" className="button" disabled={!valid}>
            Revisar ajuste
          </button>
        )}
      </div>
    </form>
  )
}

export function OperationsPanel({ bundle, onDone }: { bundle: BundleDetail; onDone: (message: string) => void }) {
  const { user } = useSession()
  const tabs: { id: Action; label: string }[] = []
  if (canOperate(user?.role)) {
    tabs.push({ id: 'exit', label: 'Salida' }, { id: 'transfer', label: 'Traslado' })
  }
  if (canAdjust(user?.role)) tabs.push({ id: 'adjustments', label: 'Ajuste' })
  const [active, setActive] = useState<Action | null>(tabs[0]?.id ?? null)

  if (tabs.length === 0) {
    return <p className="muted">Tu rol permite consultar este paquete, pero no registrar operaciones.</p>
  }
  const empty = bundle.quantity === 0

  return (
    <div>
      <div className="tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            className={active === tab.id ? 'tab active' : 'tab'}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="tab-panel">
        {empty && active !== 'adjustments' ? (
          <Notice kind="info">El paquete está agotado: no admite salidas ni traslados.</Notice>
        ) : null}
        {active === 'exit' && !empty ? <ExitForm key={bundle.quantity} bundle={bundle} onDone={onDone} /> : null}
        {active === 'transfer' && !empty ? <TransferForm bundle={bundle} onDone={onDone} /> : null}
        {active === 'adjustments' ? <AdjustmentForm bundle={bundle} onDone={onDone} /> : null}
      </div>
    </div>
  )
}
