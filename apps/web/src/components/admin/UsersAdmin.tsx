import { useState, type FormEvent } from 'react'
import type { UserRole } from '../../api/types'
import { ROLES, ROLE_DESCRIPTIONS, generatePassword, matches, type AdminUser } from '../../lib/admin'
import { useLoad } from '../../lib/useLoad'
import { useMutation } from '../../lib/useMutation'
import { useUnsavedWork } from '../../pwa/workGuard'
import { ROLE_LABELS, useSession } from '../../session/session-context'
import { IconArrow } from '../icons'
import { Empty, Field, Loading, Notice } from '../ui'

type Pending = { id: string; kind: 'role'; role: UserRole } | { id: string; kind: 'active' }

// Users: create with a role, change roles and activate/deactivate. The API
// refuses changing your own role or deactivating yourself, and never leaves
// the system without an active administrator.
export function UsersAdmin() {
  const { request, user: me } = useSession()
  const users = useLoad<AdminUser[]>('/users')
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const rowAction = useMutation()

  const rows = (users.data ?? []).filter((u) => matches(`${u.name} ${u.email} ${ROLE_LABELS[u.role]}`, search))

  const confirm = async (user: AdminUser) => {
    if (!pending) return
    const ok = await rowAction.run(() =>
      pending.kind === 'role'
        ? request(`/users/${encodeURIComponent(user.id)}/role`, { method: 'PATCH', body: { role: pending.role } })
        : request(`/users/${encodeURIComponent(user.id)}/active`, { method: 'PATCH', body: { active: !user.active } }),
    )
    if (ok) {
      setMessage(
        pending.kind === 'role'
          ? `${user.name} ahora tiene el rol ${ROLE_LABELS[pending.role]}. Aplica desde su próxima acción.`
          : `${user.name} ${user.active ? 'desactivado: su sesión deja de funcionar de inmediato' : 'activado'}.`,
      )
      users.reload()
    }
    setPending(null)
  }

  return (
    <div className="admin-layout">
      <section>
        <div className="admin-toolbar">
          <Field label="Buscar usuario">
            <input type="search" placeholder="Nombre, correo o rol" value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          {users.data ? (
            <span className="results-head">
              <span>
                <strong>{users.data.filter((u) => u.active).length}</strong> activos de {users.data.length}
              </span>
            </span>
          ) : null}
        </div>

        {message ? <Notice kind="success">{message}</Notice> : null}
        {rowAction.error ? <Notice kind="error">{rowAction.error}</Notice> : null}
        {users.error ? <Notice kind="error">{users.error}</Notice> : null}
        {users.loading && !users.data ? <Loading label="Cargando usuarios…" /> : null}
        {users.data && rows.length === 0 ? <Empty title="Sin usuarios">Ningún usuario coincide con la búsqueda.</Empty> : null}

        {rows.length > 0 ? (
          <div className="table-wrap stack">
            <table>
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Rol</th>
                  <th>Estado</th>
                  <th>
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((user) => {
                  const self = user.id === me?.id
                  const rowPending = pending?.id === user.id ? pending : null
                  return (
                    <tr key={user.id}>
                      <td className="card-title" data-label="Usuario">
                        <span className="cell-main">
                          {user.name}
                          {self ? <span className="badge">Tú</span> : null}
                        </span>
                        <span className="cell-sub">{user.email}</span>
                      </td>
                      <td data-label="Rol">
                        {self ? (
                          ROLE_LABELS[user.role]
                        ) : (
                          <span className="inline-edit">
                            <select
                              aria-label={`Rol de ${user.name}`}
                              disabled={rowAction.pending}
                              value={rowPending?.kind === 'role' ? rowPending.role : user.role}
                              onChange={(e) => {
                                const role = e.target.value as UserRole
                                setMessage(null)
                                setPending(role === user.role ? null : { id: user.id, kind: 'role', role })
                              }}
                            >
                              {ROLES.map((role) => (
                                <option key={role} value={role}>
                                  {ROLE_LABELS[role]}
                                </option>
                              ))}
                            </select>
                          </span>
                        )}
                      </td>
                      <td data-label="Estado">
                        <span className={user.active ? 'badge' : 'badge badge-muted'}>{user.active ? 'Activo' : 'Inactivo'}</span>
                      </td>
                      <td className="no-label row-actions" data-label="Acciones">
                        {rowPending ? (
                          <span className="row-confirm">
                            {rowPending.kind === 'role'
                              ? `¿Cambiar a ${ROLE_LABELS[rowPending.role]}? ${ROLE_DESCRIPTIONS[rowPending.role]}`
                              : user.active
                                ? '¿Desactivar? No podrá ingresar y su sesión actual se corta.'
                                : '¿Activar la cuenta?'}
                            <button type="button" className="text-button" disabled={rowAction.pending} onClick={() => confirm(user)}>
                              Confirmar
                            </button>
                            <button type="button" className="text-button muted-link" onClick={() => setPending(null)}>
                              Cancelar
                            </button>
                          </span>
                        ) : self ? (
                          <span className="muted">Tu cuenta</span>
                        ) : (
                          <button
                            type="button"
                            className="text-button muted-link"
                            onClick={() => {
                              setMessage(null)
                              setPending({ id: user.id, kind: 'active' })
                            }}
                          >
                            {user.active ? 'Desactivar' : 'Activar'}
                          </button>
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
        <NewUserForm
          onCreated={(user) => {
            setMessage(`Usuario ${user.name} creado con el rol ${ROLE_LABELS[user.role]}.`)
            users.reload()
          }}
        />
      </aside>
    </div>
  )
}

function NewUserForm({ onCreated }: { onCreated: (user: AdminUser) => void }) {
  const { request } = useSession()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [role, setRole] = useState<UserRole>('WAREHOUSE')
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null)
  const create = useMutation()
  // A created user's one-time password is still on screen: losing it on a
  // reload would force a reset.
  useUnsavedWork(
    name.trim() || email.trim() || password ? 'Formulario de usuario sin guardar' : created ? 'Contraseña inicial de un usuario nuevo en pantalla' : null,
  )

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password.length < 12) return create.setError('La contraseña debe tener al menos 12 caracteres.')
    const result: { user?: AdminUser } = {}
    const ok = await create.run(async () => {
      const { data } = await request<AdminUser>('/users', {
        method: 'POST',
        body: { name: name.trim(), email: email.trim(), password, role },
      })
      result.user = data
    })
    if (ok && result.user) {
      // Shown once so the admin can hand it over; it is not stored anywhere.
      setCreated({ email: result.user.email, password })
      setName('')
      setEmail('')
      setPassword('')
      setShowPassword(false)
      onCreated(result.user)
    }
  }

  return (
    <form className="task-form" onSubmit={submit}>
      <header>
        <p className="eyebrow">Accesos</p>
        <h2>Nuevo usuario</h2>
      </header>
      <div className="task-form-body">
        {created ? (
          <Notice kind="success">
            Cuenta creada para <strong>{created.email}</strong>. Contraseña inicial:{' '}
            <strong className="mono">{created.password}</strong>. Entrégala por un canal privado; no se volverá a mostrar.{' '}
            <button type="button" className="link" onClick={() => setCreated(null)}>
              Ocultar
            </button>
          </Notice>
        ) : null}
        {create.error ? <Notice kind="error">{create.error}</Notice> : null}
        <Field label="Nombre completo">
          <input type="text" required maxLength={100} disabled={create.pending} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Correo">
          <input
            type="email"
            required
            maxLength={254}
            autoComplete="off"
            disabled={create.pending}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Contraseña inicial" hint="Mínimo 12 caracteres. Aún no existe cambio de contraseña en la aplicación.">
          <span className="password-row">
            <input
              className="mono"
              type={showPassword ? 'text' : 'password'}
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              disabled={create.pending}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button type="button" className="button button-secondary" onClick={() => setShowPassword((v) => !v)}>
              {showPassword ? 'Ocultar' : 'Ver'}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={create.pending}
              onClick={() => {
                setPassword(generatePassword())
                setShowPassword(true)
              }}
            >
              Generar
            </button>
          </span>
        </Field>
        <Field label="Rol" hint={ROLE_DESCRIPTIONS[role]}>
          <select value={role} disabled={create.pending} onChange={(e) => setRole(e.target.value as UserRole)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>
        <button type="submit" className="cta" disabled={create.pending}>
          <span>{create.pending ? 'Creando…' : 'Crear usuario'}</span>
          <span className="cta-icon" aria-hidden="true">
            {create.pending ? <span className="cta-progress" /> : <IconArrow />}
          </span>
        </button>
      </div>
    </form>
  )
}
