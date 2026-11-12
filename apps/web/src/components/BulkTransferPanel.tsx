import { useRef, useState, type FormEvent } from 'react'
import { ApiError, describeError } from '../api/client'
import type { Bundle } from '../api/types'
import { EMPTY_LOCATION, isStore, placePayload, placeReady, type LocationValue } from '../lib/forms'
import { uuid } from '../lib/uuid'
import { useUnsavedWork } from '../pwa/workGuard'
import { useSession } from '../session/session-context'
import { LocationSelectors } from './LocationSelectors'
import { Field, Notice } from './ui'

// Same limit as the API (MAX_TRANSFER_BATCH): one transfer is one transaction.
export const MAX_TRANSFER = 200

interface TransferResult {
  replayed: boolean
  count: number
  profiles: number
  opened: number
  bundles: Bundle[]
}

interface Problem {
  epc: string
  message: string
}

const KEY_REUSED = /clave de operación ya se usó/i

// «Trasladar los paquetes leídos»: every registered bundle of the bulk read
// goes to one destination in ONE operation, all or none. Arriving at a retail
// store (almacén) each closed bundle is opened: its profiles become loose.
// Empty bundles and bundles already at the destination are left out.
// One key per intended transfer; kept while the outcome is unknown, so a
// retry never moves anything twice.
// `embedded`: inside the «Traslado» tab of a bundle (always open, no card).
export function BulkTransferPanel({
  bundles,
  onMoved,
  embedded = false,
}: {
  bundles: Bundle[]
  onMoved: (moved: Bundle[]) => void
  embedded?: boolean
}) {
  const { request } = useSession()
  const [open, setOpen] = useState(embedded)
  const [location, setLocation] = useState<LocationValue>(EMPTY_LOCATION)
  const [description, setDescription] = useState('')
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<Problem[]>([])
  const [done, setDone] = useState<string | null>(null)
  const key = useRef<string | null>(null)
  const uncertain = useRef(false)
  const inFlight = useRef(false)
  useUnsavedWork(open && (location.inventoryLocationId || reason.trim() || confirming) ? 'Traslado de paquetes sin confirmar' : null)

  const store = isStore(location)
  const ready = placeReady(location)
  const atDestination = (bundle: Bundle) =>
    bundle.inventoryLocationId === location.inventoryLocationId && (store || bundle.rackId === location.rackId)
  const empty = bundles.filter((bundle) => bundle.quantity === 0)
  const already = ready ? bundles.filter((bundle) => bundle.quantity > 0 && atDestination(bundle)) : []
  const selected = bundles.filter((bundle) => bundle.quantity > 0 && !(ready && atDestination(bundle)))
  const profiles = selected.reduce((total, bundle) => total + bundle.quantity, 0)
  const toOpen = store ? selected.filter((bundle) => !bundle.openedAt).length : 0
  const tooMany = selected.length > MAX_TRANSFER
  const valid = ready && selected.length > 0 && !tooMany

  const edit = (apply: () => void) => {
    apply()
    setConfirming(false)
    setDone(null)
    if (!uncertain.current) {
      key.current = null
      setError(null)
      setProblems([])
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!valid) return
    if (!confirming) return setConfirming(true)
    if (inFlight.current) return
    inFlight.current = true
    key.current ??= uuid()
    setPending(true)
    setError(null)
    setProblems([])
    try {
      const { data } = await request<TransferResult>('/inventory/bundles/transfer', {
        method: 'POST',
        body: { operationKey: key.current, bundleIds: selected.map((bundle) => bundle.id), ...placePayload(location), reason: reason.trim() || undefined },
      })
      key.current = null
      uncertain.current = false
      onMoved(data.bundles)
      setDone(
        data.replayed
          ? 'Este traslado ya estaba registrado; no se movió nada otra vez.'
          : `Trasladados ${data.count} ${data.count === 1 ? 'paquete' : 'paquetes'} (${data.profiles.toLocaleString('es-CO')} perfiles) a ${description}.` +
              (data.opened > 0 ? ` ${data.opened} ${data.opened === 1 ? 'quedó abierto' : 'quedaron abiertos'}: sus perfiles son sueltos del almacén.` : ''),
      )
      setConfirming(false)
      setReason('')
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      const retryable = err instanceof ApiError && (err.data as { retryable?: boolean } | null)?.retryable === true
      if (retryable) {
        setError(`${describeError(err)} (No se aplicó.)`)
      } else if (status === 0 || status >= 500) {
        uncertain.current = true
        setError(
          'No se recibió una respuesta clara del servidor: el traslado pudo haberse registrado. Vuelve a pulsar «Confirmar traslado»; no se aplicará dos veces.',
        )
      } else {
        const wasApplied = uncertain.current && status === 409 && KEY_REUSED.test(describeError(err))
        key.current = null
        uncertain.current = false
        const listed = (err instanceof ApiError ? (err.data as { problems?: Problem[] } | null)?.problems : undefined) ?? []
        setProblems(listed)
        setError(
          wasApplied
            ? 'El traslado anterior sí se había registrado (con los paquetes de ese momento). Revisa los paquetes antes de repetirlo.'
            : listed.length > 0
              ? 'No se trasladó ningún paquete. Quita de la lista los que tienen problema y vuelve a intentarlo:'
              : describeError(err),
        )
        setConfirming(false)
      }
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  if (!open) {
    return (
      <section className="card bulk-transfer" aria-label="Trasladar paquetes leídos">
        <div className="bulk-transfer-head">
          <div>
            <h2 className="subtitle">Trasladar los paquetes leídos</h2>
            <p className="muted">Mueve de una vez los {bundles.length} paquetes registrados a otra bodega o almacén.</p>
          </div>
          <button type="button" className="button" onClick={() => setOpen(true)}>
            Trasladar paquetes
          </button>
        </div>
        {done ? <Notice kind="success">{done}</Notice> : null}
      </section>
    )
  }

  const form = (
      <form className="form-grid" onSubmit={submit}>
        <LocationSelectors
          mode="form"
          value={location}
          disabled={pending}
          onChange={(value) => edit(() => setLocation(value))}
          onDescribe={setDescription}
          labels={{ location: 'Bodega o almacén destino', rack: 'Burro destino' }}
        />
        <Field label="Motivo o remisión (opcional)">
          <input type="text" maxLength={500} disabled={pending} value={reason} onChange={(e) => edit(() => setReason(e.target.value))} />
        </Field>

        <div className="field-wide bulk-transfer-count">
          <strong>{selected.length}</strong> {selected.length === 1 ? 'paquete' : 'paquetes'} · <strong>{profiles.toLocaleString('es-CO')}</strong> perfiles
          {empty.length > 0 ? <small> · {empty.length} agotado(s) no se incluyen</small> : null}
          {already.length > 0 ? <small> · {already.length === 1 ? '1 ya está en el destino y no se incluye' : `${already.length} ya están en el destino y no se incluyen`}</small> : null}
        </div>
        {tooMany ? (
          <div className="field-wide">
            <Notice kind="warning">Máximo {MAX_TRANSFER} paquetes por traslado. Quita algunos de la lista o hazlo en dos traslados.</Notice>
          </div>
        ) : null}
        {store && toOpen > 0 ? (
          <div className="field-wide">
            <Notice kind="info">
              Es un almacén: al llegar, {toOpen === 1 ? 'el paquete cerrado queda abierto' : `los ${toOpen} paquetes cerrados quedan abiertos`} y sus
              perfiles pasan a sueltos. Las salidas de allí serán siempre por sueltos.
            </Notice>
          </div>
        ) : null}

        {error ? (
          <div className="field-wide">
            <Notice kind="error">
              {error}
              {problems.length > 0 ? (
                <ul className="bulk-transfer-problems">
                  {problems.map((problem) => (
                    <li key={problem.epc}>
                      <span className="mono">{problem.epc}</span>: {problem.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Notice>
          </div>
        ) : null}
        {done ? <div className="field-wide"><Notice kind="success">{done}</Notice></div> : null}

        <div className="field-wide">
          {confirming ? (
            <div className="confirm" role="alertdialog" aria-label="Confirmar traslado">
              <div>
                Se trasladarán <strong>{selected.length}</strong> {selected.length === 1 ? 'paquete completo' : 'paquetes completos'} ({profiles.toLocaleString('es-CO')}{' '}
                perfiles) a <strong>{description}</strong>.
                {toOpen > 0 ? <> {toOpen === 1 ? 'Quedará abierto 1 paquete' : `Quedarán abiertos ${toOpen} paquetes`} como sueltos.</> : null}
              </div>
              <div className="actions">
                <button type="submit" className="button button-danger" disabled={pending}>
                  {pending ? 'Trasladando…' : 'Confirmar traslado'}
                </button>
                <button type="button" className="button button-secondary" disabled={pending} onClick={() => edit(() => undefined)}>
                  Volver
                </button>
              </div>
            </div>
          ) : (
            <button type="submit" className="button" disabled={!valid}>
              Revisar traslado
            </button>
          )}
        </div>
      </form>
  )

  if (embedded) return <div className="bulk-transfer embedded">{form}</div>

  return (
    <section className="card bulk-transfer" aria-label="Trasladar paquetes leídos">
      <div className="bulk-transfer-head">
        <div>
          <h2 className="subtitle">Trasladar los paquetes leídos</h2>
          <p className="muted">
            Todos o ninguno: si un paquete no se puede mover, no se mueve ninguno. Si leíste un paquete vecino por error, quítalo de la
            lista con «Quitar».
          </p>
        </div>
        <button type="button" className="text-button" disabled={pending} onClick={() => edit(() => setOpen(false))}>
          Cerrar
        </button>
      </div>
      {form}
    </section>
  )
}
