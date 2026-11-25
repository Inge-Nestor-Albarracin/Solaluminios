import { useMemo, useRef, useState } from 'react'
import { describeError } from '../api/client'
import { IconScan } from '../components/icons'
import { Field, Loading, Notice, PageHeader } from '../components/ui'
import { ORIGIN_LABEL, accessoryLabel, type AccessoryCatalog, type Basket, type Origin } from '../lib/accessories'
import { useLoad } from '../lib/useLoad'
import { uuid } from '../lib/uuid'
import { useSession } from '../session/session-context'
import type { Navigate } from './navigation'

// Registers a fixed basket once: its chip, accessory, colour, origin and the
// units it has today (inventario existente; no old exits are invented).
export function BasketRegisterView({ initialEpc, navigate }: { initialEpc?: string; navigate: Navigate }) {
  const { request } = useSession()
  const catalog = useLoad<AccessoryCatalog>('/accessories/catalog')
  const [epc, setEpc] = useState(initialEpc ?? '')
  const [filter, setFilter] = useState('')
  const [referenceId, setReferenceId] = useState('')
  const [finishId, setFinishId] = useState('')
  const [origin, setOrigin] = useState<Origin>('NATIONAL')
  const [quantity, setQuantity] = useState('')
  const [locationId, setLocationId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef<string | null>(null)
  const inFlight = useRef(false)

  const locations = catalog.data?.locations ?? []
  const location = locationId || (locations.length === 1 ? locations[0].id : '')
  const references = useMemo(() => {
    const all = catalog.data?.references ?? []
    const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return all
    return all.filter((ref) => {
      const text = `${ref.code} ${ref.supplierCode ?? ''} ${ref.description ?? ''} ${ref.brand ?? ''}`.toLowerCase()
      return words.every((w) => text.includes(w)) || ref.id === referenceId
    })
  }, [catalog.data, filter, referenceId])
  const families = useMemo(() => [...new Set(references.map((r) => r.family?.name ?? 'Sin familia'))], [references])

  const count = Number(quantity)
  const blocker = !epc.trim()
    ? 'lee el chip de la canasta'
    : !referenceId
      ? 'elige el accesorio'
      : !finishId
        ? 'elige el color'
        : quantity.trim() === '' || !Number.isInteger(count) || count < 0
          ? 'escribe cuántas unidades tiene hoy'
          : !location
            ? 'elige la bodega de accesorios'
            : null

  // Any change of the data is a new registration (new key); a retry of the
  // same data keeps the key, so a double click never registers twice.
  const touch = () => {
    key.current = null
    setError(null)
  }

  const save = async () => {
    if (inFlight.current || blocker) return
    inFlight.current = true
    key.current ??= uuid()
    setBusy(true)
    setError(null)
    try {
      const { data } = await request<Basket>('/accessories/baskets', {
        method: 'POST',
        body: { operationKey: key.current, epc: epc.trim(), referenceId, finishId, origin, quantity: count, inventoryLocationId: location },
      })
      navigate({ name: 'basket', id: data.id })
    } catch (err) {
      setError(describeError(err))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Accesorios"
        title="Registrar canasta"
        description="Se hace una sola vez por canasta: pega el chip, elige el accesorio y el color, y cuenta lo que tiene hoy. Las compras siguientes se suman con un ingreso."
        actions={
          <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'accessories' })}>
            Volver a canastas
          </button>
        }
      />
      {catalog.error ? <Notice kind="error">{catalog.error}</Notice> : null}
      {catalog.loading && !catalog.data ? <Loading /> : null}
      {catalog.data ? (
        <section className="card">
          <div className="form-grid">
            <Field label="Chip de la canasta" hint="Con el campo activo, el lector escribe el código del chip.">
              <span className="input-wrap">
                <IconScan />
                <input
                  className="mono"
                  autoFocus={!initialEpc}
                  autoComplete="off"
                  spellCheck={false}
                  value={epc}
                  onChange={(e) => {
                    setEpc(e.target.value.toUpperCase())
                    touch()
                  }}
                />
              </span>
            </Field>
            <Field label="Buscar accesorio" hint={`${references.length} de ${catalog.data.references.length} accesorios`}>
              <input value={filter} placeholder="Código, descripción o marca" onChange={(e) => setFilter(e.target.value)} />
            </Field>
            <Field label="Accesorio" wide>
              <select
                value={referenceId}
                onChange={(e) => {
                  setReferenceId(e.target.value)
                  touch()
                }}
              >
                <option value="">Elige…</option>
                {families.map((family) => (
                  <optgroup key={family} label={family}>
                    {references
                      .filter((ref) => (ref.family?.name ?? 'Sin familia') === family)
                      .map((ref) => (
                        <option key={ref.id} value={ref.id}>
                          {accessoryLabel(ref)}
                          {ref.brand ? ` · ${ref.brand}` : ''}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </Field>
            <Field label="Color">
              <select
                value={finishId}
                onChange={(e) => {
                  setFinishId(e.target.value)
                  touch()
                }}
              >
                <option value="">Elige…</option>
                {catalog.data.finishes.map((finish) => (
                  <option key={finish.id} value={finish.id}>
                    {finish.code}
                    {finish.description ? ` · ${finish.description}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Origen" hint="Un mismo accesorio siempre viene del mismo origen.">
              <select
                value={origin}
                onChange={(e) => {
                  setOrigin(e.target.value as Origin)
                  touch()
                }}
              >
                {(Object.keys(ORIGIN_LABEL) as Origin[]).map((value) => (
                  <option key={value} value={value}>
                    {ORIGIN_LABEL[value]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Unidades que tiene hoy" hint="Cuenta lo que hay en la canasta. Puede ser 0 si está vacía.">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={quantity}
                onChange={(e) => {
                  setQuantity(e.target.value)
                  touch()
                }}
              />
            </Field>
            {locations.length > 1 ? (
              <Field label="Bodega de accesorios">
                <select
                  value={locationId}
                  onChange={(e) => {
                    setLocationId(e.target.value)
                    touch()
                  }}
                >
                  <option value="">Elige…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.branch.name} · {l.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : locations.length === 1 ? (
              <Field label="Bodega de accesorios">
                <input value={`${locations[0].branch.name} · ${locations[0].name}`} readOnly />
              </Field>
            ) : null}
          </div>
          {locations.length === 0 ? (
            <Notice kind="error">No hay una bodega de accesorios disponible. El administrador debe crearla y asignártela en Usuarios.</Notice>
          ) : null}
        </section>
      ) : null}

      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="actions">
        <button type="button" className="button" disabled={busy || blocker !== null} onClick={() => void save()}>
          {busy ? 'Guardando…' : 'Registrar canasta'}
        </button>
        {blocker && !busy ? <span className="cell-sub save-blocker">Para guardar: {blocker}</span> : null}
      </div>
    </>
  )
}
