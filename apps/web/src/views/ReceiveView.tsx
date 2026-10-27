import { useRef, useState, type FormEvent } from 'react'
import { ApiError, describeError } from '../api/client'
import { IconScan } from '../components/icons'
import { LocationSelectors } from '../components/LocationSelectors'
import { Field, Notice, PageHeader } from '../components/ui'
import { EMPTY_LOCATION, type LocationValue } from '../lib/forms'
import { uuid } from '../lib/uuid'
import { useUnsavedWork } from '../pwa/workGuard'
import { useSession } from '../session/session-context'
import type { Navigate } from './navigation'

// Reception in Colombia of bundles pre-registered in China. Only now the
// bundle enters the inventory (ENTRY), keeping the provenance of its lot and
// the expected quantity apart from the received one.

interface PreRegistration {
  id: string
  epc: string
  expectedQuantity: number
  status: 'PENDING' | 'RECEIVED' | 'CANCELLED'
  reference: { code: string; description: string | null }
  finish: { code: string; description: string | null }
  shipment: { code: string }
  lot: { code: string; origin: 'CHINA' | 'NATIONAL'; supplier: { name: string } | null }
  createdBy: { name: string }
  receivedBundle: { id: string; epc: string; quantity: number } | null
}

export function ReceiveView({ navigate }: { navigate: Navigate }) {
  const { request } = useSession()
  const [epc, setEpc] = useState('')
  const [found, setFound] = useState<PreRegistration | null>(null)
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  // Location stays between receptions (same dock, same rack).
  const [location, setLocation] = useState<LocationValue>(EMPTY_LOCATION)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'warning'; text: string; bundleId?: string } | null>(null)
  const key = useRef<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useUnsavedWork(found && found.status === 'PENDING' ? 'Recepción de un paquete de China sin confirmar' : null)

  const lookup = async (event: FormEvent) => {
    event.preventDefault()
    const code = epc.trim().toUpperCase()
    if (!code) return
    setBusy(true)
    setMessage(null)
    setFound(null)
    key.current = null
    try {
      const { data } = await request<PreRegistration>(`/inbound/pre-registrations/epc/${encodeURIComponent(code)}`)
      setFound(data)
      setQuantity(String(data.expectedQuantity))
      setReason('')
    } catch (err) {
      setMessage({ kind: 'error', text: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  const amount = Number(quantity)
  const differs = found !== null && Number.isInteger(amount) && amount !== found.expectedQuantity
  const valid = found?.status === 'PENDING' && Number.isInteger(amount) && amount >= 1 && !!location.rackId && (!differs || reason.trim().length > 0)

  const receive = async () => {
    if (!found || !valid || busy) return
    setBusy(true)
    setMessage(null)
    key.current ??= uuid()
    try {
      const { data } = await request<{ replayed: boolean; bundle: { id: string; epc: string; quantity: number } }>('/inbound/receive', {
        method: 'POST',
        body: {
          epc: found.epc,
          quantity: amount,
          inventoryLocationId: location.inventoryLocationId,
          rackId: location.rackId,
          ...(differs ? { discrepancyReason: reason.trim() } : {}),
          operationKey: key.current,
        },
      })
      key.current = null
      setMessage({ kind: 'success', text: `Recibido: ${data.bundle.epc} con ${data.bundle.quantity} perfiles${data.replayed ? ' (ya estaba recibido con esta misma operación)' : ''}.`, bundleId: data.bundle.id })
      setFound(null)
      setEpc('')
      requestAnimationFrame(() => input.current?.focus())
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      const retryable = err instanceof ApiError && (err.data as { retryable?: boolean } | null)?.retryable === true
      if (status === 0 || (status >= 500 && !retryable)) {
        setMessage({ kind: 'warning', text: 'No se recibió respuesta del servidor: la recepción pudo haberse registrado. Pulsa de nuevo «Confirmar recepción» sin cambiar nada; no se sumará dos veces.' })
      } else {
        if (!retryable) key.current = null
        setMessage({ kind: 'error', text: describeError(err) })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Inventario · Entradas"
        title="Recepción de China"
        description="Lee el chip de un paquete prerregistrado en China, confirma los perfiles que llegaron y su ubicación. Solo entonces entra al inventario."
      />
      <form className="card lookup-form" onSubmit={(e) => void lookup(e)}>
        <Field label="Chip del paquete" hint="Pistola en modo teclado o escribe el código.">
          <span className="input-wrap">
            <IconScan />
            <input ref={input} className="mono" autoFocus value={epc} autoComplete="off" spellCheck={false} onChange={(e) => setEpc(e.target.value)} placeholder="E280…" />
          </span>
        </Field>
        <button type="submit" className="button" disabled={busy || !epc.trim()}>Buscar prerregistro</button>
      </form>

      {message ? (
        <Notice kind={message.kind}>
          {message.text}{' '}
          {message.bundleId ? (
            <button type="button" className="link" onClick={() => navigate({ name: 'bundle', id: message.bundleId! })}>Ver paquete</button>
          ) : null}
        </Notice>
      ) : null}

      {found ? (
        <section className="card">
          <div className="detail-grid">
            <div><span className="field-label">Referencia</span><p>{found.reference.code}{found.reference.description ? ` — ${found.reference.description}` : ''}</p></div>
            <div><span className="field-label">Acabado</span><p>{found.finish.description ?? found.finish.code}</p></div>
            <div><span className="field-label">Origen y proveedor</span><p>China · {found.lot.supplier?.name ?? '—'}</p></div>
            <div><span className="field-label">Envío / lote</span><p>{found.shipment.code} · {found.lot.code}</p></div>
            <div><span className="field-label">Perfiles previstos</span><p>{found.expectedQuantity}</p></div>
            <div><span className="field-label">Registrado en China por</span><p>{found.createdBy.name}</p></div>
          </div>
          {found.status === 'RECEIVED' ? (
            <Notice kind="warning">
              Este paquete ya fue recibido ({found.receivedBundle?.quantity} perfiles). No se vuelve a sumar.{' '}
              {found.receivedBundle ? <button type="button" className="link" onClick={() => navigate({ name: 'bundle', id: found.receivedBundle!.id })}>Ver paquete</button> : null}
            </Notice>
          ) : (
            <>
              <div className="form-grid">
                <Field label="Perfiles recibidos">
                  <input type="number" inputMode="numeric" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                </Field>
                {differs ? (
                  <Field label="Motivo de la diferencia" hint={`Se esperaban ${found.expectedQuantity}. La diferencia queda registrada y auditada.`}>
                    <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
                  </Field>
                ) : null}
                <LocationSelectors value={location} onChange={setLocation} mode="form" />
              </div>
              <div className="actions">
                <button type="button" className="button" disabled={!valid || busy} onClick={() => void receive()}>
                  {busy ? 'Registrando…' : 'Confirmar recepción'}
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}
    </>
  )
}
