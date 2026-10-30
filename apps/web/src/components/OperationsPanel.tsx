import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, describeError } from '../api/client'
import type { BundleDetail, OperationResult } from '../api/types'
import { canAdjust, canOperate, useSession } from '../session/session-context'
import { EMPTY_LOCATION, type LocationValue } from '../lib/forms'
import { uuid } from '../lib/uuid'
import { useUnsavedWork } from '../pwa/workGuard'
import { LocationSelectors } from './LocationSelectors'
import { Field, Notice } from './ui'

type Action = 'open' | 'exit' | 'transfer' | 'adjustments'

const REPLAYED = 'La operación ya estaba registrada; no se modificó el inventario otra vez.'

const KEY_REUSED = /clave de operación ya se usó/i

// One operationKey per intended operation:
// - success: discarded.
// - definitive rejection (4xx such as "saldo insuficiente"): the key was not
//   applied, so it is discarded.
// - temporary (503 retryable): not applied; kept for the retry.
// - uncertain (no response, 500): it may have been applied, so the key is kept
//   EVEN IF the user edits the form. Resending with the same key is safe: the
//   API replays it, or answers "ya se usó con otros datos" if the first
//   attempt did go through with other values.
// After any conflict or uncertain outcome the bundle is reloaded, so the
// screen never keeps showing an old balance.
function useOperation(bundleId: string, onDone: (message: string) => void, onRefresh: () => void) {
  const { request } = useSession()
  const key = useRef<string | null>(null)
  const uncertain = useRef(false)
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Called when the form data changes. While the previous result is
  // uncertain, both the key and the warning stay until the API answers.
  const reset = useCallback(() => {
    if (uncertain.current) return
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
      uncertain.current = false
      onDone(data.replayed ? REPLAYED : success(data))
      return true
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      const retryable = err instanceof ApiError && (err.data as { retryable?: boolean } | null)?.retryable === true
      if (retryable) {
        setError(`${describeError(err)} (No se aplicó.)`)
      } else if (status === 0 || status >= 500) {
        uncertain.current = true
        setError(
          'No se recibió una respuesta clara del servidor: la operación pudo haberse registrado. Revisa el historial y, si hace falta, reintenta; no se aplicará dos veces.',
        )
        onRefresh()
      } else {
        const wasApplied = uncertain.current && status === 409 && KEY_REUSED.test(describeError(err))
        key.current = null
        uncertain.current = false
        setError(
          wasApplied
            ? 'La operación anterior sí se había registrado (con los datos de ese momento). Revisa el historial antes de repetirla.'
            : describeError(err),
        )
        if (status === 409) onRefresh()
      }
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

// «Abrir paquete»: all its profiles become loose in the same place. The
// total does not change; the bundle and its chip stay as antecedents.
function OpenForm({ bundle, onDone, onRefresh }: { bundle: BundleDetail; onDone: (message: string) => void; onRefresh: () => void }) {
  const op = useOperation(bundle.id, onDone, onRefresh)
  const [confirming, setConfirming] = useState(false)
  useUnsavedWork(confirming || op.error ? 'Apertura de paquete sin confirmar' : null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!confirming) return setConfirming(true)
    const ok = await op.run('open', {}, (r) => `Paquete abierto: ${r.bundle.quantity} perfiles sueltos en ${r.bundle.inventoryLocation.name}.`)
    if (ok) setConfirming(false)
  }

  return (
    <form className="form-grid" onSubmit={submit}>
      {op.error ? <div className="field-wide"><Notice kind="error">{op.error}</Notice></div> : null}
      <p className="field-wide field-hint">
        Úsalo cuando necesites solo una parte de un paquete. Sus perfiles pasan a ser sueltos del almacén y los despachos los usan primero.
        No es una salida: el total no cambia.
      </p>
      <div className="field-wide">
        {confirming ? (
          <Confirm pending={op.pending} confirmLabel="Abrir paquete" onBack={() => { setConfirming(false); op.reset() }}>
            Los <strong>{bundle.quantity}</strong> perfiles del paquete <span className="mono">{bundle.epc}</span> pasarán a ser{' '}
            <strong>sueltos</strong> en {bundle.inventoryLocation.name}. El paquete y su chip quedan como antecedente; no se puede volver a abrir
            ni hace falta un chip nuevo.
          </Confirm>
        ) : (
          <button type="submit" className="button">Revisar apertura</button>
        )}
      </div>
    </form>
  )
}

function ExitForm({ bundle, onDone, onRefresh }: { bundle: BundleDetail; onDone: (message: string) => void; onRefresh: () => void }) {
  const op = useOperation(bundle.id, onDone, onRefresh)
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  useUnsavedWork(quantity || reason.trim() || confirming || op.error ? 'Salida de inventario sin confirmar' : null)
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

function TransferForm({ bundle, onDone, onRefresh }: { bundle: BundleDetail; onDone: (message: string) => void; onRefresh: () => void }) {
  const op = useOperation(bundle.id, onDone, onRefresh)
  const [location, setLocation] = useState<LocationValue>(EMPTY_LOCATION)
  const [description, setDescription] = useState('')
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  useUnsavedWork(location.rackId || description.trim() || reason.trim() || confirming || op.error ? 'Traslado sin confirmar' : null)
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

function AdjustmentForm({ bundle, onDone, onRefresh }: { bundle: BundleDetail; onDone: (message: string) => void; onRefresh: () => void }) {
  const op = useOperation(bundle.id, onDone, onRefresh)
  const [type, setType] = useState<'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT'>('ADJUSTMENT_IN')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  useUnsavedWork(quantity || reason.trim() || confirming || op.error ? 'Ajuste de inventario sin confirmar' : null)
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

export function OperationsPanel({ bundle, onDone, onRefresh }: { bundle: BundleDetail; onDone: (message: string) => void; onRefresh: () => void }) {
  const { user } = useSession()
  const tabs: { id: Action; label: string }[] = []
  // Closed bundles with profiles can be opened (once).
  if (canOperate(user?.role) && !bundle.openedAt && bundle.quantity > 0) tabs.push({ id: 'open', label: 'Abrir paquete' })
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
        {bundle.openedAt ? (
          <Notice kind="info">
            Paquete abierto el {new Date(bundle.openedAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}
            {bundle.openedBy ? ` por ${bundle.openedBy.name}` : ''}: sus {bundle.quantity} perfiles son sueltos del almacén. Los despachos los
            usan primero; no hace falta registrar una salida manual.
          </Notice>
        ) : null}
        {active === 'open' && !bundle.openedAt && !empty ? <OpenForm bundle={bundle} onDone={onDone} onRefresh={onRefresh} /> : null}
        {empty && active !== 'adjustments' ? (
          <Notice kind="info">El paquete está agotado: no admite salidas ni traslados.</Notice>
        ) : null}
        {active === 'exit' && !empty ? <ExitForm bundle={bundle} onDone={onDone} onRefresh={onRefresh} /> : null}
        {active === 'transfer' && !empty ? <TransferForm bundle={bundle} onDone={onDone} onRefresh={onRefresh} /> : null}
        {active === 'adjustments' ? <AdjustmentForm bundle={bundle} onDone={onDone} onRefresh={onRefresh} /> : null}
      </div>
    </div>
  )
}
