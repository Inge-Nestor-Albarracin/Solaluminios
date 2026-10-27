import { useState, type FormEvent } from 'react'
import type { InventoryLocation } from '../../api/types'
import { formatDateTime } from '../../lib/format'
import { useLoad } from '../../lib/useLoad'
import { useMutation } from '../../lib/useMutation'
import { useUnsavedWork } from '../../pwa/workGuard'
import { useSession } from '../../session/session-context'
import { Field, Notice } from '../ui'

interface Reader {
  id: string
  code: string
  name: string
  active: boolean
  simulator: boolean
  lastSeenAt: string | null
  inventoryLocation: { id: string; name: string }
  sessions: { id: string; dispatch: { id: string; number: string } }[]
}

// Phase 2: fixed readers / portal. Each device has its own id and secret
// (shown once; only its hash is stored) and posts observations to sessions
// bound to a dispatch. Capture is monitoring only and disabled unless
// READER_CAPTURE_ENABLED=true in the API.
export function ReadersAdmin() {
  const { request } = useSession()
  const readers = useLoad<Reader[]>('/readers')
  const branches = useLoad<{ id: string; name: string }[]>('/locations/branches')
  const [branchId, setBranchId] = useState('')
  const locations = useLoad<InventoryLocation[]>(branchId ? `/locations/branches/${encodeURIComponent(branchId)}/inventory-locations` : null)
  const [form, setForm] = useState({ code: '', name: '', inventoryLocationId: '', simulator: false })
  const [secret, setSecret] = useState<{ code: string; secret: string } | null>(null)
  const mutation = useMutation()

  // The secret is only on screen once: losing it means creating a new reader.
  useUnsavedWork(secret ? 'Secreto de un lector nuevo en pantalla' : form.code ? 'Formulario de lector sin guardar' : null)

  const create = async (event: FormEvent) => {
    event.preventDefault()
    await mutation.run(async () => {
      const { data } = await request<{ device: { code: string }; secret: string }>('/readers', { method: 'POST', body: form })
      setSecret({ code: data.device.code, secret: data.secret })
      setForm({ code: '', name: '', inventoryLocationId: '', simulator: false })
      readers.reload()
    })
  }

  const toggle = (reader: Reader) =>
    mutation.run(async () => {
      await request(`/readers/${encodeURIComponent(reader.id)}`, { method: 'PATCH', body: { active: !reader.active } })
      readers.reload()
    })

  return (
    <div className="admin-section">
      <Notice kind="info">
        Fase 2 (lector fijo / portal): las lecturas se validan contra el despacho y registran incidencias, pero <strong>no</strong> preparan ni descuentan inventario. La salida la confirma una persona. El simulador usa el mismo contrato y no prueba cobertura ni lectura real de radio.
      </Notice>
      {mutation.error ? <Notice kind="error">{mutation.error}</Notice> : null}
      {secret ? (
        <Notice kind="warning">
          Secreto del lector <strong>{secret.code}</strong> (se muestra una sola vez; configúralo en el adaptador, nunca en el navegador):{' '}
          <code className="mono">{secret.secret}</code>{' '}
          <button type="button" className="link" onClick={() => setSecret(null)}>Ya lo guardé</button>
        </Notice>
      ) : null}
      <section className="card">
        <ul className="doc-list">
          {(readers.data ?? []).map((reader) => (
            <li key={reader.id} className="doc-row static">
              <span className="doc-main">
                <strong>{reader.code} · {reader.name}{reader.simulator ? ' (simulador)' : ''}</strong>
                <small>
                  {reader.inventoryLocation.name} · última lectura {reader.lastSeenAt ? formatDateTime(reader.lastSeenAt) : 'nunca'}
                  {reader.sessions.length ? ` · sesión abierta con ${reader.sessions[0].dispatch.number}` : ''}
                </small>
              </span>
              <span className="doc-side">
                {!reader.active ? <span className="badge badge-muted">Inactivo</span> : null}
                <button type="button" className="text-button" disabled={mutation.pending} onClick={() => void toggle(reader)}>{reader.active ? 'Desactivar' : 'Activar'}</button>
              </span>
            </li>
          ))}
        </ul>
        <form className="form-grid" onSubmit={(e) => void create(e)}>
          <Field label="Código"><input value={form.code} maxLength={40} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
          <Field label="Nombre"><input value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Sucursal">
            <select value={branchId} onChange={(e) => { setBranchId(e.target.value); setForm({ ...form, inventoryLocationId: '' }) }}>
              <option value="">Elige…</option>
              {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Ubicación">
            <select value={form.inventoryLocationId} onChange={(e) => setForm({ ...form, inventoryLocationId: e.target.value })}>
              <option value="">Elige…</option>
              {(locations.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.simulator} onChange={(e) => setForm({ ...form, simulator: e.target.checked })} /> Es un simulador (se marca en cada lectura)
          </label>
          <div className="actions">
            <button type="submit" className="button" disabled={mutation.pending || !form.code || !form.name || !form.inventoryLocationId}>Registrar lector</button>
          </div>
        </form>
      </section>
    </div>
  )
}
