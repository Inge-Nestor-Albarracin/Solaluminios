import { useState } from 'react'
import type { Bundle, Page } from '../../api/types'
import { ORIGIN_LABEL, formatUnitCost, type MaterialOrigin, type Supplier } from '../../lib/commerce'
import { EMPTY_CATALOG, type CatalogValue } from '../../lib/forms'
import { useLoad } from '../../lib/useLoad'
import { useMutation } from '../../lib/useMutation'
import { useUnsavedWork } from '../../pwa/workGuard'
import { useSession } from '../../session/session-context'
import { CatalogSelectors } from '../CatalogSelectors'
import { Field, Notice } from '../ui'

interface Lot {
  id: string
  code: string
  kind: 'CHINA_SHIPMENT' | 'MANUAL_ENTRY' | 'OPENING'
  origin: MaterialOrigin
  unitCost: string | null
  reference: { code: string }
  finish: { code: string; description: string | null }
  supplier: { name: string } | null
  shipment: { code: string } | null
  purchaseLine: { purchase: { documentNumber: string } } | null
  _count: { bundles: number; preRegistrations: number }
  totals: { bundles: number; profiles: number; inStock: number; pendingBundles: number; pendingProfiles: number }
}

interface UnclassifiedGroup {
  reference: { id: string; code: string }
  finish: { id: string; code: string; description: string | null }
  location: { name: string }
  bundles: number
  profiles: number
}

const KIND_LABEL = { CHINA_SHIPMENT: 'Envío China', MANUAL_ENTRY: 'Ingreso', OPENING: 'Apertura' } as const

// Lots: canonical provenance and cost. Historical stock without origin is
// classified here into an opening lot (no new stock, audited). Nothing is
// labelled as China by default.
export function LotsAdmin() {
  const { request } = useSession()
  const [catalog, setCatalog] = useState<CatalogValue>(EMPTY_CATALOG)
  const [origin, setOrigin] = useState<MaterialOrigin>('NATIONAL')
  const [supplierId, setSupplierId] = useState('')
  const [notes, setNotes] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const mutation = useMutation()
  const enc = encodeURIComponent
  const unclassified = useLoad<UnclassifiedGroup[]>('/lots/unclassified')
  const lots = useLoad<Page<Lot>>(`/lots?pageSize=30${catalog.referenceId ? `&referenceId=${enc(catalog.referenceId)}` : ''}`)
  const suppliers = useLoad<Supplier[]>('/suppliers?active=true')
  const candidates = useLoad<Page<Bundle>>(
    catalog.referenceId && catalog.finishId ? `/inventory/bundles?referenceId=${enc(catalog.referenceId)}&finishId=${enc(catalog.finishId)}&unclassified=true&available=true&pageSize=100` : null,
  )

  useUnsavedWork(selected.length > 0 ? 'Clasificación de paquetes sin aplicar' : null)

  const classify = async () => {
    const ok = await mutation.run(async () => {
      const { data: lot } = await request<{ id: string; code: string }>('/lots/opening', {
        method: 'POST',
        body: { referenceId: catalog.referenceId, finishId: catalog.finishId, origin, ...(supplierId ? { supplierId } : {}), notes: notes.trim() },
      })
      await request(`/lots/${enc(lot.id)}/bundles`, { method: 'POST', body: { bundleIds: selected } })
      setMessage(`${selected.length} paquete(s) clasificados en el lote ${lot.code}. No se creó inventario nuevo.`)
    })
    if (ok) {
      setSelected([])
      setNotes('')
      unclassified.reload()
      candidates.reload()
      lots.reload()
    }
  }

  return (
    <div className="admin-section">
      {mutation.error ? <Notice kind="error">{mutation.error}</Notice> : null}
      {message ? <Notice kind="success">{message}</Notice> : null}

      <section className="card">
        <h2 className="subtitle">Inventario sin procedencia</h2>
        <p className="field-hint">Paquetes registrados antes de manejar origen y proveedor. No se venden como China ni Nacional hasta clasificarlos con evidencia.</p>
        {unclassified.data && unclassified.data.length === 0 ? <p className="field-hint">Todo el inventario con existencias tiene procedencia.</p> : null}
        <ul className="doc-list">
          {(unclassified.data ?? []).map((group) => (
            <li key={`${group.reference.id}-${group.finish.id}-${group.location.name}`} className="doc-row static">
              <span className="doc-main">
                <strong>{group.reference.code} · {group.finish.description ?? group.finish.code}</strong>
                <small>{group.location.name}</small>
              </span>
              <span className="doc-side">{group.bundles} paquetes · {group.profiles} perfiles</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2 className="subtitle">Clasificar con un lote de apertura</h2>
        <div className="form-grid">
          <CatalogSelectors mode="form" value={catalog} onChange={(value) => { setCatalog(value); setSelected([]) }} />
          <Field label="Origen">
            <select value={origin} onChange={(e) => { setOrigin(e.target.value as MaterialOrigin); setSupplierId('') }}>
              <option value="NATIONAL">Nacional</option>
              <option value="CHINA">China</option>
            </select>
          </Field>
          <Field label="Proveedor" hint={origin === 'NATIONAL' ? 'Opcional si no está documentado.' : 'Vacío: el proveedor de China configurado.'}>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">{origin === 'NATIONAL' ? 'No documentado' : 'Proveedor de China configurado'}</option>
              {(suppliers.data ?? []).filter((s) => s.origins.includes(origin)).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Evidencia de la procedencia" hint="Obligatorio: inventario físico, documento, declaración…">
            <input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        {candidates.data ? (
          candidates.data.items.length === 0 ? (
            <p className="field-hint">No hay paquetes sin procedencia de ese material.</p>
          ) : (
            <ul className="check-list">
              {candidates.data.items.map((bundle) => (
                <li key={bundle.id}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={selected.includes(bundle.id)}
                      onChange={(e) => setSelected(e.target.checked ? [...selected, bundle.id] : selected.filter((id) => id !== bundle.id))}
                    />{' '}
                    <span className="mono">{bundle.epc}</span> · {bundle.quantity} perfiles · {bundle.inventoryLocation.name}
                  </label>
                </li>
              ))}
            </ul>
          )
        ) : null}
        <div className="actions">
          <button type="button" className="button" disabled={mutation.pending || selected.length === 0 || !notes.trim()} onClick={() => void classify()}>
            Clasificar {selected.length || ''} paquete(s)
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="subtitle">Lotes</h2>
        <ul className="doc-list">
          {(lots.data?.items ?? []).map((lot) => (
            <li key={lot.id} className="doc-row static">
              <span className="doc-main">
                <strong>{lot.code} · {lot.reference.code} {lot.finish.description ?? lot.finish.code}</strong>
                <small>
                  {KIND_LABEL[lot.kind]} · {ORIGIN_LABEL[lot.origin]}{lot.supplier ? ` · ${lot.supplier.name}` : ''}
                  {lot.shipment ? ` · envío ${lot.shipment.code}` : ''}
                  {lot.purchaseLine ? ` · compra ${lot.purchaseLine.purchase.documentNumber}` : ''} · {lot.totals.bundles} paquetes ·{' '}
                  {lot.totals.profiles} perfiles ingresados ({lot.totals.inStock} en existencia)
                  {lot.totals.pendingBundles > 0 ? ` · por recibir ${lot.totals.pendingBundles} paquetes · ${lot.totals.pendingProfiles} perfiles` : ''}
                </small>
              </span>
              <span className="doc-side">{lot.unitCost ? `${formatUnitCost(lot.unitCost)} / perfil` : <span className="badge badge-warning">Costo pendiente</span>}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
