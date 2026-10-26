import { useState, type FormEvent } from 'react'
import type { Family } from '../../api/types'
import { matches } from '../../lib/admin'
import { useLoad } from '../../lib/useLoad'
import { useMutation } from '../../lib/useMutation'
import { useUnsavedWork } from '../../pwa/workGuard'
import { useSession } from '../../session/session-context'
import { IconArrow } from '../icons'
import { Empty, Field, Loading, Notice } from '../ui'

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._/-]*$/

// Product families: create, rename and activate/deactivate. Deactivating a
// family keeps its references; it only blocks new associations.
export function FamiliesAdmin() {
  const { request } = useSession()
  const families = useLoad<Family[]>('/catalog/families')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string; version?: string } | null>(null)
  const [confirmToggle, setConfirmToggle] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const rowAction = useMutation()

  // After a failed edit (e.g. 409: changed by someone else) show fresh data.
  const runAndRefresh = async (action: () => Promise<unknown>) => {
    const ok = await rowAction.run(action)
    if (!ok) {
      // Leave edit mode so the freshly loaded values are visible.
      setEditing(null)
      families.reload()
    }
    return ok
  }

  const rows = (families.data ?? []).filter((f) => matches(`${f.code} ${f.name}`, search))

  const saveName = async () => {
    if (!editing) return
    const name = editing.name.trim()
    if (!name) return rowAction.setError('El nombre no puede quedar vacío.')
    const ok = await runAndRefresh(() =>
      request(`/catalog/families/${encodeURIComponent(editing.id)}`, {
        method: 'PATCH',
        body: { name, expectedUpdatedAt: editing.version },
      }),
    )
    if (ok) {
      setMessage(`Familia renombrada: ${name}.`)
      setEditing(null)
      families.reload()
    }
  }

  const toggle = async (family: Family) => {
    const ok = await runAndRefresh(() =>
      request(`/catalog/families/${encodeURIComponent(family.id)}`, {
        method: 'PATCH',
        body: { active: !family.active, expectedUpdatedAt: family.updatedAt },
      }),
    )
    setConfirmToggle(null)
    if (ok) {
      setMessage(`Familia ${family.code} ${family.active ? 'desactivada' : 'activada'}.`)
      families.reload()
    }
  }

  return (
    <div className="admin-layout">
      <section>
        <div className="admin-toolbar">
          <Field label="Buscar familia">
            <input type="search" placeholder="Código o nombre" value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          {families.data ? (
            <span className="results-head">
              <span>
                <strong>{rows.length}</strong> de {families.data.length} familias
              </span>
            </span>
          ) : null}
        </div>

        {message ? <Notice kind="success">{message}</Notice> : null}
        {rowAction.error ? <Notice kind="error">{rowAction.error}</Notice> : null}
        {families.error ? <Notice kind="error">{families.error}</Notice> : null}
        {families.loading && !families.data ? <Loading label="Cargando familias…" /> : null}
        {families.data && rows.length === 0 ? (
          <Empty title="Sin familias">{search ? 'Ninguna familia coincide con la búsqueda.' : 'Crea la primera familia con el formulario.'}</Empty>
        ) : null}

        {rows.length > 0 ? (
          <div className="table-wrap stack">
            <table>
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Nombre</th>
                  <th>Estado</th>
                  <th>
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((family) => (
                  <tr key={family.id}>
                    <td className="card-title mono" data-label="Código">
                      <span className="cell-main">{family.code}</span>
                    </td>
                    <td data-label="Nombre">
                      {editing?.id === family.id ? (
                        <span className="inline-edit">
                          <input
                            type="text"
                            maxLength={100}
                            aria-label={`Nuevo nombre de ${family.code}`}
                            value={editing.name}
                            onChange={(e) => setEditing({ id: family.id, name: e.target.value })}
                          />
                        </span>
                      ) : (
                        family.name
                      )}
                    </td>
                    <td data-label="Estado">
                      <span className={family.active ? 'badge' : 'badge badge-muted'}>{family.active ? 'Activa' : 'Inactiva'}</span>
                    </td>
                    <td className="no-label row-actions" data-label="Acciones">
                      {editing?.id === family.id ? (
                        <>
                          <button type="button" className="text-button" disabled={rowAction.pending} onClick={saveName}>
                            Guardar
                          </button>
                          <button type="button" className="text-button muted-link" onClick={() => setEditing(null)}>
                            Cancelar
                          </button>
                        </>
                      ) : confirmToggle === family.id ? (
                        <span className="row-confirm">
                          {family.active
                            ? 'Sus referencias se conservan; no se podrán asociar nuevas. ¿Desactivar?'
                            : '¿Activar la familia?'}
                          <button type="button" className="text-button" disabled={rowAction.pending} onClick={() => toggle(family)}>
                            Sí
                          </button>
                          <button type="button" className="text-button muted-link" onClick={() => setConfirmToggle(null)}>
                            No
                          </button>
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              setConfirmToggle(null)
                              setEditing({ id: family.id, name: family.name, version: family.updatedAt })
                            }}
                          >
                            Renombrar
                          </button>
                          <button
                            type="button"
                            className="text-button muted-link"
                            onClick={() => {
                              setEditing(null)
                              setConfirmToggle(family.id)
                            }}
                          >
                            {family.active ? 'Desactivar' : 'Activar'}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <aside className="admin-aside">
        <NewFamilyForm
          onCreated={(family) => {
            setMessage(`Familia ${family.code} creada.`)
            families.reload()
          }}
        />
      </aside>
    </div>
  )
}

function NewFamilyForm({ onCreated }: { onCreated: (family: Family) => void }) {
  const { request } = useSession()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const create = useMutation()
  useUnsavedWork(code.trim() || name.trim() ? 'Formulario de familia sin guardar' : null)
  const normalized = code.trim().toUpperCase()
  const codeInvalid = normalized !== '' && !CODE_PATTERN.test(normalized)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!normalized || codeInvalid) return create.setError('El código solo admite letras, números y . _ / -')
    if (!name.trim()) return create.setError('Escribe el nombre de la familia.')
    const result: { family?: Family } = {}
    const ok = await create.run(async () => {
      const { data } = await request<Family>('/catalog/families', { method: 'POST', body: { code: normalized, name: name.trim() } })
      result.family = data
    })
    if (ok && result.family) {
      setCode('')
      setName('')
      onCreated(result.family)
    }
  }

  return (
    <form className="task-form" onSubmit={submit}>
      <header>
        <p className="eyebrow">Catálogo</p>
        <h2>Nueva familia</h2>
      </header>
      <div className="task-form-body">
        {create.error ? <Notice kind="error">{create.error}</Notice> : null}
        <Field label="Código" hint="Ej. 3831. Se guarda en mayúsculas y no se puede cambiar después.">
          <input
            className="mono"
            type="text"
            required
            maxLength={50}
            autoCapitalize="characters"
            disabled={create.pending}
            value={code}
            aria-invalid={codeInvalid}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="Nombre">
          <input
            type="text"
            required
            maxLength={100}
            placeholder="Ej. Ventana proyectante"
            disabled={create.pending}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <button type="submit" className="cta" disabled={create.pending}>
          <span>{create.pending ? 'Guardando…' : 'Crear familia'}</span>
          <span className="cta-icon" aria-hidden="true">
            {create.pending ? <span className="cta-progress" /> : <IconArrow />}
          </span>
        </button>
      </div>
    </form>
  )
}
