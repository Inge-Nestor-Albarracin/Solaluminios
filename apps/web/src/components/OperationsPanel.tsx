import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, describeError } from '../api/client'
import type { Bundle, BundleDetail, OperationResult } from '../api/types'
import { canAdjust, canOperate, useSession } from '../session/session-context'
import { bundlePlace } from '../lib/format'
import { uuid } from '../lib/uuid'
import { useUnsavedWork } from '../pwa/workGuard'
import { BulkTransferPanel, MAX_TRANSFER } from './BulkTransferPanel'
import { IconScan } from './icons'
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

// «Traslado» of the bundle on screen. Other bundles can be added by their
// chip (reader in keyboard mode, or typed) to move a few together; one alone
// also works. Same rules as the multiple transfer of Lectura masiva: all or
// none, whole bundles, opened on arrival at a retail store.
function TransferForm({ bundle, onRefresh }: { bundle: BundleDetail; onRefresh: () => void }) {
  const { request } = useSession()
  const [others, setOthers] = useState<Bundle[]>([])
  const [chip, setChip] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  useUnsavedWork(others.length > 0 ? 'Paquetes agregados al traslado sin confirmar' : null)
  const list: Bundle[] = [bundle, ...others]

  const add = async (event: FormEvent) => {
    event.preventDefault()
    const epc = chip.trim().toUpperCase()
    if (!epc || adding) return
    setAddError(null)
    if (!/^[A-Z0-9]+$/.test(epc)) return setAddError('El código del chip solo puede contener letras y números, sin espacios.')
    if (list.some((item) => item.epc === epc)) {
      setChip('')
      return setAddError(`El chip ${epc} ya está en la lista.`)
    }
    if (list.length >= MAX_TRANSFER) return setAddError(`Máximo ${MAX_TRANSFER} paquetes por traslado.`)
    setAdding(true)
    try {
      const { data } = await request<Bundle>(`/inventory/bundles/epc/${encodeURIComponent(epc)}`)
      if (data.quantity === 0) {
        setAddError(`El paquete ${epc} está agotado; no se traslada.`)
      } else {
        setOthers((current) => (current.some((item) => item.id === data.id) ? current : [...current, data]))
      }
      setChip('')
    } catch (err) {
      setAddError(err instanceof ApiError && err.status === 404 ? `No hay un paquete registrado con el chip ${epc}.` : describeError(err))
    } finally {
      setAdding(false)
    }
  }

  // After the transfer: the added bundles show their new place; the bundle
  // on screen and its history are reloaded.
  const moved = (bundles: Bundle[]) => {
    const byId = new Map(bundles.map((item) => [item.id, item]))
    setOthers((current) => current.map((item) => byId.get(item.id) ?? item))
    onRefresh()
  }

  return (
    <div className="transfer-tab">
      <p className="muted">
        Se trasladan paquetes completos; la cantidad no cambia. Puedes trasladar solo este paquete o agregar otros leyendo su chip.
      </p>

      <ul className="transfer-list" aria-label="Paquetes a trasladar">
        {list.map((item, index) => (
          <li key={item.id}>
            <span>
              <span className="mono">{item.epc}</span>
              <small>
                {item.reference.code} · {item.quantity} perf. · {bundlePlace(item)}
                {item.openedAt ? ' · abierto' : ''}
              </small>
            </span>
            {index === 0 ? (
              <span className="badge badge-muted">Este paquete</span>
            ) : (
              <button type="button" className="text-button" onClick={() => setOthers((current) => current.filter((other) => other.id !== item.id))}>
                Quitar
              </button>
            )}
          </li>
        ))}
      </ul>

      <form className="transfer-add" onSubmit={add}>
        <Field label="Agregar otro paquete (opcional)" hint="Lee el chip con la pistola en modo teclado o escribe el código y pulsa Enter.">
          <span className="input-wrap">
            <IconScan />
            <input
              className="mono"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="E2003412…"
              value={chip}
              disabled={adding}
              onChange={(e) => {
                setChip(e.target.value.toUpperCase())
                setAddError(null)
              }}
            />
          </span>
        </Field>
        <button type="submit" className="button button-secondary" disabled={adding || !chip.trim()}>
          {adding ? 'Buscando…' : 'Agregar'}
        </button>
      </form>
      {addError ? <Notice kind="error">{addError}</Notice> : null}

      <BulkTransferPanel bundles={list} onMoved={moved} embedded />
    </div>
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
        {active === 'transfer' && !empty ? <TransferForm bundle={bundle} onRefresh={onRefresh} /> : null}
        {active === 'adjustments' ? <AdjustmentForm bundle={bundle} onDone={onDone} onRefresh={onRefresh} /> : null}
      </div>
    </div>
  )
}
