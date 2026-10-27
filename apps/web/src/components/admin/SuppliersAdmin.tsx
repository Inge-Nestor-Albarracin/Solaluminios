import { useState, type FormEvent } from 'react'
import { ORIGIN_LABEL, type MaterialOrigin, type Supplier } from '../../lib/commerce'
import type { AdminUser } from '../../lib/admin'
import { useLoad } from '../../lib/useLoad'
import { useMutation } from '../../lib/useMutation'
import { useUnsavedWork } from '../../pwa/workGuard'
import { useSession } from '../../session/session-context'
import { Field, Loading, Notice } from '../ui'

interface Settings {
  chinaSupplier: { id: string; code: string; name: string; active: boolean } | null
  dispatchSupervisor: { id: string; name: string } | null
}

interface Shipment {
  id: string
  code: string
  status: 'OPEN' | 'CLOSED'
  createdAt: string
  supplier: { name: string }
  _count: { preRegistrations: number }
}

// Real supplier names are entered here (none are invented). A supplier may
// provide China and/or National material; the fixed Chinese supplier and
// the dispatch supervisor are configured below.
export function SuppliersAdmin() {
  const { request } = useSession()
  const suppliers = useLoad<Supplier[]>('/suppliers')
  const settings = useLoad<Settings>('/supply/settings')
  const users = useLoad<AdminUser[]>('/users')
  const shipments = useLoad<Shipment[]>('/china/shipments')
  const [form, setForm] = useState({ code: '', name: '', taxId: '', origins: [] as MaterialOrigin[] })
  const [shipmentCode, setShipmentCode] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const mutation = useMutation()

  useUnsavedWork(form.code || form.name ? 'Formulario de proveedor sin guardar' : null)

  const create = async (event: FormEvent) => {
    event.preventDefault()
    const ok = await mutation.run(() =>
      request('/suppliers', { method: 'POST', body: { code: form.code, name: form.name, origins: form.origins, ...(form.taxId.trim() ? { taxId: form.taxId.trim() } : {}) } }),
    )
    if (ok) {
      setForm({ code: '', name: '', taxId: '', origins: [] })
      setMessage('Proveedor creado.')
      suppliers.reload()
    }
  }

  const toggle = (supplier: Supplier) =>
    mutation.run(async () => {
      await request(`/suppliers/${encodeURIComponent(supplier.id)}`, { method: 'PATCH', body: { active: !supplier.active } })
      suppliers.reload()
    })

  const saveSetting = (body: Record<string, string | null>) =>
    mutation.run(async () => {
      await request('/supply/settings', { method: 'PATCH', body })
      settings.reload()
      setMessage('Configuración guardada.')
    })

  const openShipment = async (event: FormEvent) => {
    event.preventDefault()
    const ok = await mutation.run(() => request('/china/shipments', { method: 'POST', body: { code: shipmentCode } }))
    if (ok) {
      setShipmentCode('')
      shipments.reload()
    }
  }

  const closeShipment = (id: string) =>
    mutation.run(async () => {
      await request(`/china/shipments/${encodeURIComponent(id)}/close`, { method: 'POST' })
      shipments.reload()
    })

  const chinaCandidates = (suppliers.data ?? []).filter((s) => s.active && s.origins.includes('CHINA'))
  const supervisors = (users.data ?? []).filter((u) => u.active && (u.role === 'ADMIN' || u.role === 'WAREHOUSE'))

  return (
    <div className="admin-section">
      {mutation.error ? <Notice kind="error">{mutation.error}</Notice> : null}
      {message ? <Notice kind="success">{message}</Notice> : null}

      <section className="card">
        <h2 className="subtitle">Configuración</h2>
        {settings.loading && !settings.data ? <Loading /> : null}
        <div className="form-grid">
          <Field label="Proveedor fijo de China" hint="Se asigna automáticamente a los prerregistros de los operadores de China.">
            <select value={settings.data?.chinaSupplier?.id ?? ''} disabled={mutation.pending} onChange={(e) => void saveSetting({ chinaSupplierId: e.target.value || null })}>
              <option value="">Sin configurar</option>
              {chinaCandidates.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Supervisor de despachos (opcional)" hint="No es necesario para registrar ni despachar. Si se elige, recibe las incidencias y los atrasos además del responsable.">
            <select value={settings.data?.dispatchSupervisor?.id ?? ''} disabled={mutation.pending} onChange={(e) => void saveSetting({ dispatchSupervisorId: e.target.value || null })}>
              <option value="">Sin supervisor</option>
              {supervisors.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      <section className="card">
        <h2 className="subtitle">Proveedores</h2>
        <ul className="doc-list">
          {(suppliers.data ?? []).map((supplier) => (
            <li key={supplier.id} className="doc-row static">
              <span className="doc-main">
                <strong>{supplier.name}</strong>
                <small>{supplier.code}{supplier.taxId ? ` · NIT ${supplier.taxId}` : ''} · {supplier.origins.map((o) => ORIGIN_LABEL[o]).join(' y ')}</small>
              </span>
              <span className="doc-side">
                {!supplier.active ? <span className="badge badge-muted">Inactivo</span> : null}
                <button type="button" className="text-button" disabled={mutation.pending} onClick={() => void toggle(supplier)}>
                  {supplier.active ? 'Desactivar' : 'Activar'}
                </button>
              </span>
            </li>
          ))}
        </ul>
        <form className="form-grid" onSubmit={(e) => void create(e)}>
          <Field label="Código"><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} maxLength={30} /></Field>
          <Field label="Nombre"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={150} /></Field>
          <Field label="NIT (opcional)"><input value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} maxLength={30} /></Field>
          <fieldset className="field">
            <span className="field-label">Origen que suministra</span>
            {(['CHINA', 'NATIONAL'] as const).map((origin) => (
              <label key={origin} className="check">
                <input
                  type="checkbox"
                  checked={form.origins.includes(origin)}
                  onChange={(e) => setForm({ ...form, origins: e.target.checked ? [...form.origins, origin] : form.origins.filter((o) => o !== origin) })}
                />{' '}
                {ORIGIN_LABEL[origin]}
              </label>
            ))}
          </fieldset>
          <div className="actions">
            <button type="submit" className="button" disabled={mutation.pending || !form.code || !form.name || form.origins.length === 0}>Crear proveedor</button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2 className="subtitle">Envíos de China</h2>
        <p className="field-hint">Se abren solos con el primer prerregistro de China: no hace falta crearlos ni escribir un código. Opcionalmente puedes cerrar el abierto cuando salga el contenedor o abrir uno con un código propio.</p>
        <ul className="doc-list">
          {(shipments.data ?? []).map((shipment) => (
            <li key={shipment.id} className="doc-row static">
              <span className="doc-main">
                <strong>{shipment.code}</strong>
                <small>{shipment.supplier.name} · {shipment._count.preRegistrations} paquetes prerregistrados</small>
              </span>
              <span className="doc-side">
                <span className={`badge ${shipment.status === 'OPEN' ? '' : 'badge-muted'}`}>{shipment.status === 'OPEN' ? 'Abierto' : 'Cerrado'}</span>
                {shipment.status === 'OPEN' ? (
                  <button type="button" className="text-button" disabled={mutation.pending} onClick={() => void closeShipment(shipment.id)}>Cerrar</button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        <form className="form-grid" onSubmit={(e) => void openShipment(e)}>
          <Field label="Código del nuevo envío (opcional)"><input value={shipmentCode} onChange={(e) => setShipmentCode(e.target.value)} maxLength={40} /></Field>
          <div className="actions">
            <button type="submit" className="button button-secondary" disabled={mutation.pending || !shipmentCode.trim()}>Abrir envío</button>
          </div>
        </form>
      </section>
    </div>
  )
}
