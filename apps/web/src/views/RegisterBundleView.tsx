import { useRef, useState, type FormEvent } from 'react'
import { ApiError, describeError } from '../api/client'
import type { Bundle } from '../api/types'
import { useUnsavedWork } from '../pwa/workGuard'
import { ArrivalFields } from '../components/ArrivalFields'
import { CatalogSelectors, type CatalogLabels } from '../components/CatalogSelectors'
import { IconArrow, IconScan } from '../components/icons'
import { LocationSelectors } from '../components/LocationSelectors'
import { RegistrationQueuePanel } from '../components/RegistrationQueuePanel'
import { Field, Notice, PageHeader, Section } from '../components/ui'
import { MONTHS } from '../lib/format'
import {
  EMPTY_ARRIVAL,
  EMPTY_CATALOG,
  EMPTY_LOCATION,
  arrivalPayload,
  type ArrivalValue,
  type CatalogValue,
  type LocationValue,
} from '../lib/forms'
import { MAX_QUEUE_SIZE, type QueueItem, type RegistrationQueue } from '../lib/registrationQueue'
import { uuid } from '../lib/uuid'
import { useSession } from '../session/session-context'
import type { Navigate } from './navigation'

type RegistrationType = 'INITIAL_STOCK' | 'ENTRY'

const EPC_PATTERN = /^[A-Z0-9]+$/

const TYPES: { value: RegistrationType; label: string; hint: string }[] = [
  { value: 'INITIAL_STOCK', label: 'Inventario existente', hint: 'Ya estaba en bodega antes del software' },
  { value: 'ENTRY', label: 'Entrada nueva', hint: 'Mercancía recién recibida' },
]

function arrivalText(arrival: ArrivalValue): string | null {
  if (arrival.precision === 'UNKNOWN') return 'Desconocida'
  if (arrival.precision === 'EXACT') {
    if (!arrival.date) return null
    const [y, m, d] = arrival.date.split('-')
    return `${d}/${m}/${y}`
  }
  if (!arrival.month || !arrival.year) return null
  return `${MONTHS[Number(arrival.month) - 1]} de ${arrival.year}`
}

interface BatchResult {
  replayed: boolean
  count: number
  bundles: Bundle[]
}

// Registration in two steps: "Guardar y continuar" adds the bundle to a local
// list; "Guardar definitivo" sends the whole list in one transaction.
export function RegisterBundleView({
  initialEpc,
  navigate,
  queue,
}: {
  initialEpc?: string
  navigate: Navigate
  queue: RegistrationQueue
}) {
  const { request } = useSession()
  const [registrationType, setRegistrationType] = useState<RegistrationType>('INITIAL_STOCK')
  const [catalog, setCatalog] = useState<CatalogValue>(EMPTY_CATALOG)
  const [catalogLabels, setCatalogLabels] = useState<CatalogLabels>({ family: '', reference: '', finish: '' })
  const [location, setLocation] = useState<LocationValue>(EMPTY_LOCATION)
  const [locationLabel, setLocationLabel] = useState('')
  const [arrival, setArrival] = useState<ArrivalValue>(EMPTY_ARRIVAL)
  const [quantity, setQuantity] = useState('')
  const [epc, setEpc] = useState(initialEpc ?? '')
  const [notes, setNotes] = useState('')
  const [checking, setChecking] = useState(false)
  const [added, setAdded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Chip already in the inventory when trying to add it to the list.
  const [existingEpc, setExistingEpc] = useState<string | null>(null)
  // Final save state.
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [problemEpcs, setProblemEpcs] = useState<string[]>([])
  // Chips of the list that the server reports as already registered.
  const [conflicts, setConflicts] = useState<string[]>([])
  const [saved, setSaved] = useState<BatchResult | null>(null)
  const epcInput = useRef<HTMLInputElement>(null)
  // Blocks a second click before React re-renders with the busy state.
  const lock = useRef(false)

  const normalizedEpc = epc.trim().toUpperCase()
  useUnsavedWork(
    normalizedEpc !== '' || quantity !== '' || notes.trim() !== '' ? 'Formulario de registro con datos sin agregar a la lista' : null,
  )
  const epcInvalid = normalizedEpc !== '' && !EPC_PATTERN.test(normalizedEpc)
  const amount = Number(quantity)
  const quantityValid = quantity !== '' && Number.isInteger(amount) && amount >= 1
  const arrivalLabel = arrivalText(arrival)
  const queueFull = queue.items.length >= MAX_QUEUE_SIZE
  const busy = checking || saving

  const steps = [
    true,
    !!catalog.referenceId && !!catalog.finishId,
    arrivalLabel !== null,
    !!location.rackId,
    normalizedEpc !== '' && !epcInvalid && quantityValid,
  ]
  const completed = steps.filter(Boolean).length

  // "Guardar y continuar": validates and adds to the list. Nothing is written
  // to the inventory yet.
  const addToQueue = async (event: FormEvent) => {
    event.preventDefault()
    if (lock.current) return
    setAdded(null)
    setSaved(null)
    setExistingEpc(null)
    if (queueFull) {
      setError(`La lista admite hasta ${MAX_QUEUE_SIZE} paquetes. Guarda la lista antes de continuar.`)
      return
    }
    if (!quantityValid) {
      setError('La cantidad debe ser un número entero de perfiles mayor que cero.')
      return
    }
    if (!normalizedEpc || epcInvalid) {
      setError('El código del chip solo puede contener letras y números, sin espacios.')
      return
    }
    const position = queue.items.findIndex((item) => item.body.epc === normalizedEpc)
    if (position >= 0) {
      setError(`Este chip ya está en la lista (paquete ${position + 1}).`)
      return
    }

    lock.current = true
    setChecking(true)
    setError(null)
    try {
      // Early warning: the final save checks again inside its transaction.
      await request(`/inventory/bundles/epc/${encodeURIComponent(normalizedEpc)}`)
      setError(`El chip ${normalizedEpc} ya está registrado en el inventario; no se agregó a la lista.`)
      setExistingEpc(normalizedEpc)
      return
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        setError(describeError(err))
        return
      }
    } finally {
      lock.current = false
      setChecking(false)
    }

    const item: QueueItem = {
      id: uuid(),
      body: {
        epc: normalizedEpc,
        referenceId: catalog.referenceId,
        finishId: catalog.finishId,
        quantity: amount,
        inventoryLocationId: location.inventoryLocationId,
        rackId: location.rackId,
        registrationType,
        ...arrivalPayload(arrival),
        notes: notes.trim() || undefined,
      },
      labels: {
        type: TYPES.find((t) => t.value === registrationType)?.label ?? '',
        reference: catalogLabels.reference,
        finish: catalogLabels.finish,
        arrival: arrivalLabel ?? '',
        location: locationLabel,
      },
    }
    queue.add(item)
    setAdded(`Chip ${normalizedEpc} agregado a la lista (${queue.items.length + 1}). Lee el siguiente.`)
    // Keep product, arrival and location to speed up consecutive bundles.
    setEpc('')
    setQuantity('')
    setNotes('')
    // After the re-render: the field is still disabled while "checking".
    requestAnimationFrame(() => {
      epcInput.current?.focus({ preventScroll: true })
      // One column: bring the chip back into view for the next bundle.
      if (window.matchMedia('(max-width: 1023px)').matches) {
        epcInput.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    })
  }

  // "Guardar definitivo": one transaction for the whole list. The same retry
  // key is sent until the list changes, so resending after a lost response
  // never duplicates bundles: the API answers with the saved result.
  const saveAll = async () => {
    if (lock.current || queue.items.length === 0) return false
    lock.current = true
    setSaving(true)
    setSaveError(null)
    setProblemEpcs([])
    setConflicts([])
    setAdded(null)
    try {
      const { data } = await request<BatchResult>('/inventory/bundles/batch', {
        method: 'POST',
        body: { operationKey: queue.batchKey(), bundles: queue.items.map((item) => item.body) },
      })
      queue.clear()
      setSaved(data)
      return true
    } catch (err) {
      const data = err instanceof ApiError ? (err.data as { itemIndex?: number; epcs?: string[] } | null) : null
      const failed = typeof data?.itemIndex === 'number' ? queue.items[data.itemIndex]?.body.epc : undefined
      setProblemEpcs([...(data?.epcs ?? []), ...(failed ? [failed] : [])])
      setConflicts(data?.epcs ?? [])
      // The batch key is kept in every case until the list changes, so a
      // resend is always recognised by the API (never saved twice).
      const retryable = err instanceof ApiError && (err.data as { retryable?: boolean } | null)?.retryable === true
      const unknownOutcome = !retryable && err instanceof ApiError && (err.status === 0 || err.status >= 500)
      setSaveError(
        retryable
          ? `${describeError(err)} No se guardó ningún paquete; pulsa de nuevo «Confirmar guardado» para reintentar la misma lista.`
          : unknownOutcome
            ? 'No se recibió la respuesta del servidor, así que no sabemos si la lista se guardó y sigue aquí marcada como NO guardada. Pulsa de nuevo «Confirmar guardado»: si el intento anterior sí se guardó, se reconocerá y no se duplicará nada.'
            : `${describeError(err)} No se guardó ningún paquete de la lista.`,
      )
      return false
    } finally {
      lock.current = false
      setSaving(false)
    }
  }

  // Opens the bundle that already uses this chip; the list is kept.
  const viewExisting = async (chip: string) => {
    try {
      const { data } = await request<{ id: string }>(`/inventory/bundles/epc/${encodeURIComponent(chip)}`)
      navigate({ name: 'bundle', id: data.id })
    } catch (err) {
      setSaveError(describeError(err))
    }
  }

  const summaryRows: [string, string | null, boolean?][] = [
    ['Tipo', TYPES.find((t) => t.value === registrationType)?.label ?? null],
    ['Referencia', catalogLabels.reference || null],
    ['Acabado', catalogLabels.finish || null],
    ['Llegada', arrivalLabel],
    ['Ubicación', location.rackId ? locationLabel : null],
    ['Chip', normalizedEpc && !epcInvalid ? normalizedEpc : null, true],
    ['Perfiles', quantityValid ? `${amount} ${amount === 1 ? 'perfil' : 'perfiles'}` : null],
  ]

  // Feedback + "Guardar y continuar": in the summary panel on desktop and
  // right below chip and quantity on one-column layouts (see App.css).
  const submitArea = (
    <>
      {added ? <Notice kind="success">{added}</Notice> : null}
      {error ? (
        <Notice kind="error">
          {error}
          {existingEpc ? (
            <>
              {' '}
              <button type="button" className="link" onClick={() => viewExisting(existingEpc)}>
                Ver el paquete existente
              </button>
            </>
          ) : null}
        </Notice>
      ) : null}

      <button type="submit" className="cta" disabled={busy || queueFull}>
        <span aria-live="polite">{checking ? 'Verificando chip…' : 'Guardar y continuar'}</span>
        <span className="cta-icon" aria-hidden="true">
          {checking ? <span className="cta-progress" /> : <IconArrow />}
        </span>
      </button>
    </>
  )

  return (
    <>
      <PageHeader
        eyebrow="Inventario · Registro"
        title="Registrar paquetes"
        description="Lee cada paquete y pulsa «Guardar y continuar» para agregarlo a la lista. Al terminar, confirma el guardado definitivo: toda la lista se guarda junta o no se guarda ninguno."
      />

      {queue.items.length > 0 ? (
        <div className="pending-banner" role="status">
          <span>
            <strong>
              {queue.items.length} {queue.items.length === 1 ? 'paquete sin guardar' : 'paquetes sin guardar'}.
            </strong>{' '}
            Todavía no están en el inventario: confirma el guardado definitivo en la lista.
          </span>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => document.getElementById('registration-queue')?.scrollIntoView({ behavior: 'smooth' })}
          >
            Ver la lista
          </button>
        </div>
      ) : null}
      {queue.recovered > 0 && queue.items.length > 0 ? (
        <Notice kind="info">
          Se recuperó la lista pendiente de esta pestaña ({queue.recovered}{' '}
          {queue.recovered === 1 ? 'paquete' : 'paquetes'}). Sigue <strong>sin guardar</strong> hasta confirmar el
          guardado definitivo.{' '}
          <button type="button" className="link" onClick={queue.dismissRecovered}>
            Entendido
          </button>
        </Notice>
      ) : null}
      {queue.status === 'corrupt' ? (
        <Notice kind="warning">
          No se pudo leer la lista pendiente guardada en esta pestaña y se ignoró. Revisa en Paquetes qué quedó
          registrado antes de volver a leer esos chips.
        </Notice>
      ) : null}

      <form className="register-layout" onSubmit={addToQueue}>
        <div>
          <Section number="01" title="Tipo de registro" description="Define qué movimiento inicial se registra.">
            <fieldset className="field field-wide fieldset" disabled={busy} aria-label="Tipo de registro">
              <div className="segmented" role="radiogroup">
                {TYPES.map((type) => (
                  <label key={type.value} className={registrationType === type.value ? 'segment selected' : 'segment'}>
                    <input
                      type="radio"
                      name="registrationType"
                      value={type.value}
                      checked={registrationType === type.value}
                      onChange={() => setRegistrationType(type.value)}
                    />
                    <span>
                      {type.label}
                      <small>{type.hint}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </Section>

          <Section number="02" title="Producto" description="La familia filtra las referencias. Referencia y acabado se guardan por separado.">
            <CatalogSelectors
              mode="form"
              value={catalog}
              onChange={setCatalog}
              onDescribe={setCatalogLabels}
              disabled={busy}
            />
          </Section>

          <Section number="03" title="Llegada física" description="No se inventa un día si solo se conoce el mes o no hay registro.">
            <ArrivalFields value={arrival} onChange={setArrival} disabled={busy} />
          </Section>

          <Section number="04" title="Ubicación" description="Sucursal, bodega, pasillo y burro donde queda el paquete.">
            <LocationSelectors
              mode="form"
              value={location}
              onChange={setLocation}
              onDescribe={setLocationLabel}
              disabled={busy}
            />
          </Section>

          <Section number="05" title="Etiqueta RFID y perfiles" description="Lee el chip UHF con el lector o escribe su código, y la cantidad del paquete.">
            <Field label="Código del chip" wide hint="Se guarda en mayúsculas y conserva los ceros iniciales.">
              <span className="input-wrap large">
                <IconScan />
                <input
                  ref={epcInput}
                  className="mono"
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  required
                  placeholder="E2003412…"
                  disabled={busy}
                  value={epc}
                  aria-invalid={epcInvalid}
                  onChange={(e) => setEpc(e.target.value.toUpperCase())}
                />
              </span>
              {epcInvalid ? <span className="field-error">Solo letras y números, sin espacios.</span> : null}
            </Field>
            {/* Right below the chip: chip and quantity are what change between
                consecutive bundles, so phones barely need to scroll. */}
            <Field label="Perfiles en el paquete" wide hint="Cantidad física disponible hoy, en perfiles enteros.">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                required
                placeholder="Ej. 10"
                disabled={busy}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </Field>
            <Field label="Notas (opcional)" wide>
              <textarea
                rows={2}
                maxLength={500}
                placeholder="Observaciones del paquete"
                disabled={busy}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
            {/* One-column layouts save right here instead of below the summary. */}
            <div className="register-inline-actions field-wide">{submitArea}</div>
            <p className="field-hint field-wide">La lectura con el lector Bluetooth aún debe comprobarse con el equipo real.</p>
          </Section>
        </div>

        <aside className="register-aside">
          <section className="summary-panel" aria-label="Paquete actual">
            <header>
              <p className="eyebrow">Paquete actual</p>
              <h2>Nuevo paquete</h2>
              <div className="progress-steps" aria-label={`${completed} de ${steps.length} secciones completas`}>
                {steps.map((done, index) => (
                  <i key={index} className={done ? 'done' : undefined} />
                ))}
              </div>
            </header>
            <dl className="summary-list">
              {summaryRows.map(([label, value, mono]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd className={value ? (mono ? 'mono' : undefined) : 'pending'}>{value ?? 'Pendiente'}</dd>
                </div>
              ))}
            </dl>
            <footer>
              <div className="summary-actions">{submitArea}</div>
              <p className="summary-note">
                Se agrega a la lista; nada se guarda en el inventario hasta el guardado definitivo. Producto, llegada y
                ubicación se conservan para el siguiente paquete.
              </p>
            </footer>
          </section>

          <RegistrationQueuePanel
            items={queue.items}
            storage={queue.status}
            saving={saving}
            saveError={saveError}
            problemEpcs={problemEpcs}
            conflicts={conflicts}
            saved={saved}
            onRemove={(id) => {
              queue.remove(id)
              setSaveError(null)
            }}
            onClear={() => {
              queue.clear()
              setSaveError(null)
              setProblemEpcs([])
              setConflicts([])
            }}
            onSave={saveAll}
            onOpen={(id) => navigate({ name: 'bundle', id })}
            onViewExisting={viewExisting}
          />
        </aside>
      </form>
    </>
  )
}
