import { useState, type FormEvent } from 'react'
import type { Family, Reference } from '../../api/types'
import { matches } from '../../lib/admin'
import { referenceLabel } from '../../lib/format'
import { useLoad } from '../../lib/useLoad'
import { useMutation } from '../../lib/useMutation'
import { useUnsavedWork } from '../../pwa/workGuard'
import { useSession } from '../../session/session-context'
import { IconArrow } from '../icons'
import { Empty, Field, Loading, Notice } from '../ui'

// Like the API: one space allowed between parts («703 CURVO»).
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._/-]*(?: [A-Z0-9._/-]+)*$/
// The list is filtered in the browser; render at most this many rows.
const MAX_ROWS = 100

interface Editing {
  id: string
  description: string
  familyId: string
  familyHint: string
  supplierCode: string
  brand: string
}

// References (profiles): create, edit description/family, activate/deactivate.
// The code is the identity of the profile and cannot be changed.
// Accessory references: the code is internal; the table shows the supplier's
// code (or nothing) with the description and the brand.
export function ReferencesAdmin() {
  const { request } = useSession()
  const references = useLoad<Reference[]>('/catalog/references')
  const families = useLoad<Family[]>('/catalog/families')
  const [search, setSearch] = useState('')
  const [familyFilter, setFamilyFilter] = useState('')
  const [stateFilter, setStateFilter] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [confirmToggle, setConfirmToggle] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const rowAction = useMutation()

  const familyById = new Map((families.data ?? []).map((f) => [f.id, f]))
  const activeFamilies = (families.data ?? []).filter((f) => f.active)
  const isAccessory = (reference: Pick<Reference, 'familyId'>) =>
    reference.familyId !== null && familyById.get(reference.familyId)?.kind === 'ACCESSORY'
  const label = (reference: Reference) => (isAccessory(reference) ? `«${referenceLabel(reference, true)}»` : reference.code)

  const filtered = (references.data ?? []).filter(
    (r) =>
      matches(`${r.code} ${r.supplierCode ?? ''} ${r.description ?? ''} ${r.brand ?? ''}`, search) &&
      (familyFilter === '' || (familyFilter === 'none' ? r.familyId === null : r.familyId === familyFilter)) &&
      (stateFilter === '' || String(r.active) === stateFilter),
  )
  const rows = filtered.slice(0, MAX_ROWS)

  // After a failed edit (e.g. 409: changed by someone else) show fresh data.
  const runAndRefresh = async (action: () => Promise<unknown>) => {
    const ok = await rowAction.run(action)
    if (!ok) {
      // Leave edit mode so the freshly loaded values are visible.
      setEditing(null)
      references.reload()
    }
    return ok
  }

  const save = async () => {
    if (!editing) return
    const current = references.data?.find((r) => r.id === editing.id)
    // Only the fields this admin changed, plus the version they saw: an edit
    // made meanwhile by someone else is answered with 409, not overwritten.
    const body: Record<string, unknown> = { expectedUpdatedAt: current?.updatedAt }
    const description = editing.description.trim() || null
    if ((current?.description ?? null) !== description) body.description = description
    // Omitted keeps the family, null removes it, an id sets it.
    if ((current?.familyId ?? '') !== editing.familyId) body.familyId = editing.familyId || null
    const familyHint = editing.familyHint.trim() || null
    if ((current?.familyHint ?? null) !== familyHint) body.familyHint = familyHint
    const supplierCode = editing.supplierCode.trim() || null
    if ((current?.supplierCode ?? null) !== supplierCode) body.supplierCode = supplierCode
    const brand = editing.brand.trim() || null
    if ((current?.brand ?? null) !== brand) body.brand = brand
    if (Object.keys(body).length === 1) {
      setEditing(null)
      return
    }
    const ok = await runAndRefresh(() =>
      request(`/catalog/references/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body }),
    )
    if (ok) {
      setMessage(`Referencia ${current ? label(current) : ''} actualizada.`)
      setEditing(null)
      references.reload()
    }
  }

  const toggle = async (reference: Reference) => {
    const ok = await runAndRefresh(() =>
      request(`/catalog/references/${encodeURIComponent(reference.id)}`, {
        method: 'PATCH',
        body: { active: !reference.active, expectedUpdatedAt: reference.updatedAt },
      }),
    )
    setConfirmToggle(null)
    if (ok) {
      setMessage(`Referencia ${label(reference)} ${reference.active ? 'desactivada' : 'activada'}.`)
      references.reload()
    }
  }

  return (
    <div className="admin-layout">
      <section>
        <div className="admin-toolbar">
          <Field label="Buscar referencia">
            <input type="search" placeholder="Código, descripción o marca" value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <Field label="Familia">
            <select value={familyFilter} onChange={(e) => setFamilyFilter(e.target.value)}>
              <option value="">Todas</option>
              <option value="none">Sin familia</option>
              {(families.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.code} — {f.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Estado">
            <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
              <option value="">Todas</option>
              <option value="true">Activas</option>
              <option value="false">Inactivas</option>
            </select>
          </Field>
        </div>

        {references.data ? (
          <p className="results-head">
            <span>
              <strong>{filtered.length}</strong> de {references.data.length} referencias
              {filtered.length > MAX_ROWS ? ` · se muestran las primeras ${MAX_ROWS}; afina la búsqueda` : ''}
            </span>
          </p>
        ) : null}
        {message ? <Notice kind="success">{message}</Notice> : null}
        {rowAction.error ? <Notice kind="error">{rowAction.error}</Notice> : null}
        {references.error ? <Notice kind="error">{references.error}</Notice> : null}
        {references.loading && !references.data ? <Loading label="Cargando referencias…" /> : null}
        {references.data && rows.length === 0 ? (
          <Empty title="Sin referencias">Ninguna referencia coincide con los filtros.</Empty>
        ) : null}

        {rows.length > 0 ? (
          <div className="table-wrap stack">
            <table>
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Descripción</th>
                  <th>Familia</th>
                  <th>Estado</th>
                  <th>
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((reference) => {
                  const family = reference.familyId ? familyById.get(reference.familyId) : undefined
                  const isEditing = editing?.id === reference.id
                  const accessory = family?.kind === 'ACCESSORY'
                  return (
                    <tr key={reference.id}>
                      <td className="card-title mono" data-label="Código">
                        {accessory ? (
                          isEditing ? (
                            <span className="inline-edit">
                              <input
                                type="text"
                                maxLength={50}
                                placeholder="Código del proveedor (opcional)"
                                aria-label={`Código del proveedor de ${reference.description ?? reference.code}`}
                                value={editing.supplierCode}
                                onChange={(e) => setEditing({ ...editing, supplierCode: e.target.value })}
                              />
                            </span>
                          ) : (
                            <>
                              {reference.supplierCode ? <span className="cell-main">{reference.supplierCode}</span> : <span className="muted">Sin código</span>}
                              <span className="cell-sub" title="Código interno: no se muestra fuera de esta pantalla"> · interno {reference.code}</span>
                            </>
                          )
                        ) : (
                          <span className="cell-main">{reference.code}</span>
                        )}
                      </td>
                      <td data-label="Descripción">
                        {isEditing ? (
                          <span className="inline-edit">
                            <input
                              type="text"
                              maxLength={255}
                              aria-label={`Descripción de ${reference.code}`}
                              value={editing.description}
                              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                            />
                            {accessory ? (
                              <input
                                type="text"
                                maxLength={100}
                                placeholder="Marca o proveedor (opcional)"
                                aria-label={`Marca de ${reference.description ?? reference.code}`}
                                value={editing.brand}
                                onChange={(e) => setEditing({ ...editing, brand: e.target.value })}
                              />
                            ) : null}
                          </span>
                        ) : (
                          <>
                            {reference.description ?? <span className="muted">Sin descripción</span>}
                            {reference.brand ? <span className="cell-sub"> · {reference.brand}</span> : null}
                          </>
                        )}
                      </td>
                      <td data-label="Familia">
                        {isEditing ? (
                          <span className="inline-edit">
                            <select
                              aria-label={`Familia de ${reference.code}`}
                              value={editing.familyId}
                              onChange={(e) => setEditing({ ...editing, familyId: e.target.value })}
                            >
                              <option value="">Sin familia</option>
                              {activeFamilies.map((f) => (
                                <option key={f.id} value={f.id}>
                                  {f.code} — {f.name}
                                </option>
                              ))}
                              {family && !family.active ? (
                                <option value={family.id}>
                                  {family.code} — {family.name} (inactiva, actual)
                                </option>
                              ) : null}
                            </select>
                            <input
                              type="text"
                              maxLength={200}
                              placeholder="También aparece en… (opcional)"
                              aria-label={`Otras familias donde se conoce ${reference.code}`}
                              value={editing.familyHint}
                              onChange={(e) => setEditing({ ...editing, familyHint: e.target.value })}
                            />
                          </span>
                        ) : family ? (
                          <>
                            {family.code} — {family.name}
                            {reference.familyHint ? <span className="cell-sub"> · También aparece en: {reference.familyHint}</span> : null}
                          </>
                        ) : (
                          <span className="muted">Sin familia</span>
                        )}
                      </td>
                      <td data-label="Estado">
                        <span className={reference.active ? 'badge' : 'badge badge-muted'}>
                          {reference.active ? 'Activa' : 'Inactiva'}
                        </span>
                      </td>
                      <td className="no-label row-actions" data-label="Acciones">
                        {isEditing ? (
                          <>
                            <button type="button" className="text-button" disabled={rowAction.pending} onClick={save}>
                              Guardar
                            </button>
                            <button type="button" className="text-button muted-link" onClick={() => setEditing(null)}>
                              Cancelar
                            </button>
                          </>
                        ) : confirmToggle === reference.id ? (
                          <span className="row-confirm">
                            {reference.active
                              ? 'No se podrá usar en registros nuevos; los paquetes existentes no cambian. ¿Desactivar?'
                              : '¿Activar la referencia?'}
                            <button type="button" className="text-button" disabled={rowAction.pending} onClick={() => toggle(reference)}>
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
                                setEditing({
                                  id: reference.id,
                                  description: reference.description ?? '',
                                  familyId: reference.familyId ?? '',
                                  familyHint: reference.familyHint ?? '',
                                  supplierCode: reference.supplierCode ?? '',
                                  brand: reference.brand ?? '',
                                })
                              }}
                            >
                              Editar
                            </button>
                            <button
                              type="button"
                              className="text-button muted-link"
                              onClick={() => {
                                setEditing(null)
                                setConfirmToggle(reference.id)
                              }}
                            >
                              {reference.active ? 'Desactivar' : 'Activar'}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <aside className="admin-aside">
        <NewReferenceForm
          families={activeFamilies}
          onCreated={(reference) => {
            setMessage(`Referencia ${reference.supplierCode || reference.description || reference.code} creada.`)
            references.reload()
          }}
        />
      </aside>
    </div>
  )
}

function NewReferenceForm({ families, onCreated }: { families: Family[]; onCreated: (reference: Reference) => void }) {
  const { request } = useSession()
  const [code, setCode] = useState('')
  const [description, setDescription] = useState('')
  const [familyId, setFamilyId] = useState('')
  const [supplierCode, setSupplierCode] = useState('')
  const [brand, setBrand] = useState('')
  const accessory = families.find((f) => f.id === familyId)?.kind === 'ACCESSORY'
  const create = useMutation()
  useUnsavedWork(code.trim() || description.trim() ? 'Formulario de referencia sin guardar' : null)
  const normalized = code.trim().replace(/\s+/g, ' ').toUpperCase()
  const codeInvalid = normalized !== '' && !CODE_PATTERN.test(normalized)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!normalized || codeInvalid) return create.setError('El código solo admite letras, números, . _ / - y un espacio entre partes (p. ej. «703 CURVO»)')
    const result: { reference?: Reference } = {}
    const ok = await create.run(async () => {
      const { data } = await request<Reference>('/catalog/references', {
        method: 'POST',
        body: {
          code: normalized,
          description: description.trim() || undefined,
          familyId: familyId || undefined,
          ...(accessory ? { supplierCode: supplierCode.trim() || undefined, brand: brand.trim() || undefined } : {}),
        },
      })
      result.reference = data
    })
    if (ok && result.reference) {
      setCode('')
      setDescription('')
      setSupplierCode('')
      setBrand('')
      onCreated(result.reference)
    }
  }

  return (
    <form className="task-form" onSubmit={submit}>
      <header>
        <p className="eyebrow">Catálogo</p>
        <h2>Nueva referencia</h2>
      </header>
      <div className="task-form-body">
        {create.error ? <Notice kind="error">{create.error}</Notice> : null}
        <Field
          label={accessory ? 'Código interno' : 'Código'}
          hint={
            accessory
              ? 'Solo para el sistema (ej. ACC-101); no se muestra. Se guarda en mayúsculas y no se puede cambiar.'
              : 'Identifica el perfil (ej. 173). Se guarda en mayúsculas y no se puede cambiar.'
          }
        >
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
        <Field label="Descripción (opcional)" hint="El acabado (color) se elige al registrar cada paquete.">
          <input
            type="text"
            maxLength={255}
            placeholder="Ej. Sillar proyectante"
            disabled={create.pending}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label="Familia (opcional)">
          <select value={familyId} disabled={create.pending} onChange={(e) => setFamilyId(e.target.value)}>
            <option value="">Sin familia</option>
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.code} — {f.name}
              </option>
            ))}
          </select>
        </Field>
        {accessory ? (
          <>
            <Field label="Código del proveedor (opcional)" hint="El que se muestra. Sin él, el accesorio se muestra solo con su descripción.">
              <input type="text" className="mono" maxLength={50} disabled={create.pending} value={supplierCode} onChange={(e) => setSupplierCode(e.target.value)} />
            </Field>
            <Field label="Marca o proveedor (opcional)">
              <input type="text" maxLength={100} placeholder="Ej. YALE" disabled={create.pending} value={brand} onChange={(e) => setBrand(e.target.value)} />
            </Field>
          </>
        ) : null}
        <button type="submit" className="cta" disabled={create.pending}>
          <span>{create.pending ? 'Guardando…' : 'Crear referencia'}</span>
          <span className="cta-icon" aria-hidden="true">
            {create.pending ? <span className="cta-progress" /> : <IconArrow />}
          </span>
        </button>
      </div>
    </form>
  )
}
