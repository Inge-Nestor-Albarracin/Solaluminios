import { useState, type FormEvent } from 'react'
import type { Page, UserRole } from '../../api/types'
import {
  LOGIN_EVENT_LABEL,
  ROLES,
  ROLE_DESCRIPTIONS,
  USERNAME_PATTERN,
  matches,
  suggestUsername,
  type AdminUser,
  type LoginEvent,
  type LoginEventType,
} from '../../lib/admin'
import { formatDateTime } from '../../lib/format'
import { useLoad } from '../../lib/useLoad'
import { useMutation } from '../../lib/useMutation'
import { useUnsavedWork } from '../../pwa/workGuard'
import { ROLE_LABELS, useSession } from '../../session/session-context'
import { IconArrow } from '../icons'
import { Empty, Field, Loading, Notice } from '../ui'

type Pending =
  | { id: string; kind: 'role'; role: UserRole }
  | { id: string; kind: 'active' }
  | { id: string; kind: 'reset'; idNumber: string }
  | { id: string; kind: 'username'; username: string }

const ID_NUMBER = /^\d{5,12}$/
const usernameProblem = (value: string) =>
  value.length < 3 || value.length > 50 || !USERNAME_PATTERN.test(value)
    ? 'minúsculas y números, separados por punto, guion o guion bajo (p. ej. pedro.alvarez), de 3 a 50 caracteres'
    : null

// Users: create with a user name and the ID number as initial password (to
// be changed at the first login), change roles, user names and locations,
// reset a forgotten password and activate/deactivate. The API refuses
// changing your own role, deactivating yourself or resetting your own
// password, and never leaves the system without an active administrator.
// Below: the log of logins and password changes.
export function UsersAdmin() {
  const { request, user: me } = useSession()
  const users = useLoad<AdminUser[]>('/users')
  // Dispatches are assigned to warehouse staff of the dispatch location.
  const locations = useLoad<{ id: string; name: string; branch: { name: string } }[]>('/locations/inventory-locations')
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [eventsKey, setEventsKey] = useState(0)
  const rowAction = useMutation()
  useUnsavedWork(pending?.kind === 'reset' && pending.idNumber ? 'Restablecimiento de contraseña sin confirmar' : null)

  const rows = (users.data ?? []).filter((u) => matches(`${u.name} ${u.username} ${u.email ?? ''} ${ROLE_LABELS[u.role]}`, search))

  const confirm = async (user: AdminUser) => {
    if (!pending) return
    const path = `/users/${encodeURIComponent(user.id)}`
    const ok = await rowAction.run(() =>
      pending.kind === 'role'
        ? request(`${path}/role`, { method: 'PATCH', body: { role: pending.role } })
        : pending.kind === 'active'
          ? request(`${path}/active`, { method: 'PATCH', body: { active: !user.active } })
          : pending.kind === 'reset'
            ? request(`${path}/reset-password`, { method: 'POST', body: { idNumber: pending.idNumber } })
            : request(`${path}/username`, { method: 'PATCH', body: { username: pending.username.trim().toLowerCase() } }),
    )
    if (ok) {
      setMessage(
        pending.kind === 'role'
          ? `${user.name} ahora tiene el rol ${ROLE_LABELS[pending.role]}. Aplica desde su próxima acción.`
          : pending.kind === 'active'
            ? `${user.name} ${user.active ? 'desactivado: su sesión deja de funcionar de inmediato' : 'activado'}.`
            : pending.kind === 'reset'
              ? `Contraseña de ${user.name} restablecida a su cédula. Sus sesiones abiertas se cerraron y al ingresar deberá cambiarla.`
              : `${user.name} ahora ingresa con el usuario ${pending.username.trim().toLowerCase()}.`,
      )
      users.reload()
      setEventsKey((k) => k + 1)
      setPending(null)
    }
  }

  const blocker =
    pending?.kind === 'reset'
      ? ID_NUMBER.test(pending.idNumber.trim())
        ? null
        : 'escribe la cédula (solo números, 5 a 12 dígitos)'
      : pending?.kind === 'username'
        ? usernameProblem(pending.username.trim().toLowerCase())
        : null

  return (
    <div className="admin-layout">
      <section>
        <div className="admin-toolbar">
          <Field label="Buscar usuario">
            <input type="search" placeholder="Nombre, usuario, correo o rol" value={search} onChange={(e) => setSearch(e.target.value)} />
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
                  <th>Ubicación</th>
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
                        <span className="cell-sub mono">{user.username}</span>
                        {user.email ? <span className="cell-sub">{user.email}</span> : null}
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
                      <td data-label="Ubicación">
                        <select
                          aria-label={`Ubicación de ${user.name}`}
                          disabled={rowAction.pending}
                          value={user.defaultInventoryLocationId ?? ''}
                          onChange={async (e) => {
                            const inventoryLocationId = e.target.value || null
                            setMessage(null)
                            const ok = await rowAction.run(() =>
                              request(`/users/${encodeURIComponent(user.id)}/location`, { method: 'PATCH', body: { inventoryLocationId } }),
                            )
                            if (ok) {
                              setMessage(`${user.name}: ubicación actualizada.`)
                              users.reload()
                            }
                          }}
                        >
                          <option value="">Sin ubicación</option>
                          {(locations.data ?? []).map((location) => (
                            <option key={location.id} value={location.id}>
                              {location.branch.name} · {location.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td data-label="Estado">
                        <span className={user.active ? 'badge' : 'badge badge-muted'}>{user.active ? 'Activo' : 'Inactivo'}</span>
                        {user.mustChangePassword ? <span className="badge badge-warning">Con clave inicial</span> : null}
                        <span className="cell-sub">{user.lastLoginAt ? `Último ingreso ${formatDateTime(user.lastLoginAt)}` : 'Sin ingresos registrados'}</span>
                      </td>
                      <td className="no-label row-actions" data-label="Acciones">
                        {rowPending ? (
                          <span className="row-confirm">
                            {rowPending.kind === 'reset' ? (
                              <>
                                Su contraseña vuelve a ser su cédula y deberá cambiarla al ingresar.
                                <input
                                  aria-label={`Cédula de ${user.name}`}
                                  inputMode="numeric"
                                  autoComplete="off"
                                  placeholder="Cédula"
                                  value={rowPending.idNumber}
                                  disabled={rowAction.pending}
                                  onChange={(e) => setPending({ ...rowPending, idNumber: e.target.value.replace(/\D/g, '').slice(0, 12) })}
                                />
                              </>
                            ) : rowPending.kind === 'username' ? (
                              <>
                                Nuevo usuario para ingresar:
                                <input
                                  aria-label={`Usuario de ${user.name}`}
                                  autoComplete="off"
                                  spellCheck={false}
                                  value={rowPending.username}
                                  disabled={rowAction.pending}
                                  onChange={(e) => setPending({ ...rowPending, username: e.target.value })}
                                />
                              </>
                            ) : rowPending.kind === 'role' ? (
                              `¿Cambiar a ${ROLE_LABELS[rowPending.role]}? ${ROLE_DESCRIPTIONS[rowPending.role]}`
                            ) : user.active ? (
                              '¿Desactivar? No podrá ingresar y su sesión actual se corta.'
                            ) : (
                              '¿Activar la cuenta?'
                            )}
                            {blocker ? <span className="cell-sub">{blocker}</span> : null}
                            <button type="button" className="text-button" disabled={rowAction.pending || blocker !== null} onClick={() => confirm(user)}>
                              Confirmar
                            </button>
                            <button type="button" className="text-button muted-link" onClick={() => setPending(null)}>
                              Cancelar
                            </button>
                          </span>
                        ) : self ? (
                          <span className="muted">Tu cuenta</span>
                        ) : (
                          <span className="row-links">
                            <button
                              type="button"
                              className="text-button muted-link"
                              onClick={() => {
                                setMessage(null)
                                setPending({ id: user.id, kind: 'reset', idNumber: '' })
                              }}
                            >
                              Restablecer clave
                            </button>
                            <button
                              type="button"
                              className="text-button muted-link"
                              onClick={() => {
                                setMessage(null)
                                setPending({ id: user.id, kind: 'username', username: user.username })
                              }}
                            >
                              Cambiar usuario
                            </button>
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
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        <LoginEventsPanel key={eventsKey} users={users.data ?? []} />
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
  const [username, setUsername] = useState('')
  const [usernameTouched, setUsernameTouched] = useState(false)
  const [idNumber, setIdNumber] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<UserRole>('WAREHOUSE')
  const [created, setCreated] = useState<{ name: string; username: string } | null>(null)
  const create = useMutation()
  useUnsavedWork(name.trim() || idNumber || email.trim() ? 'Formulario de usuario sin guardar' : null)

  // Suggested from the name until the administrator edits it.
  const login = usernameTouched ? username.trim().toLowerCase() : suggestUsername(name)
  const problem = !name.trim()
    ? 'escribe el nombre'
    : usernameProblem(login)
      ? `usuario: ${usernameProblem(login)}`
      : !ID_NUMBER.test(idNumber)
        ? 'escribe la cédula (solo números, 5 a 12 dígitos)'
        : null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (problem) return create.setError(`Para crear: ${problem}.`)
    const result: { user?: AdminUser } = {}
    const ok = await create.run(async () => {
      const { data } = await request<AdminUser>('/users', {
        method: 'POST',
        body: { name: name.trim(), username: login, idNumber, ...(email.trim() ? { email: email.trim() } : {}), role },
      })
      result.user = data
    })
    if (ok && result.user) {
      setCreated({ name: result.user.name, username: result.user.username })
      setName('')
      setUsername('')
      setUsernameTouched(false)
      setIdNumber('')
      setEmail('')
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
            Cuenta creada para <strong>{created.name}</strong>. Ingresa con el usuario <strong className="mono">{created.username}</strong> y su cédula
            como contraseña; al primer ingreso deberá cambiarla.{' '}
            <button type="button" className="link" onClick={() => setCreated(null)}>
              Ocultar
            </button>
          </Notice>
        ) : null}
        {create.error ? <Notice kind="error">{create.error}</Notice> : null}
        <Field label="Nombre completo">
          <input type="text" required maxLength={100} disabled={create.pending} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Usuario para ingresar" hint="Se sugiere con el nombre; puedes cambiarlo. Minúsculas, sin tildes, p. ej. pedro.alvarez.">
          <input
            className="mono"
            type="text"
            maxLength={50}
            autoComplete="off"
            spellCheck={false}
            disabled={create.pending}
            value={login}
            onChange={(e) => {
              setUsernameTouched(true)
              setUsername(e.target.value)
            }}
          />
        </Field>
        <Field label="Cédula (contraseña inicial)" hint="Solo para el primer ingreso: el sistema le pedirá cambiarla por una propia. No se guarda como dato.">
          <input
            inputMode="numeric"
            autoComplete="off"
            disabled={create.pending}
            value={idNumber}
            // Digits only, then at most 12 («1.098.765.432» pasted with dots
            // keeps all its digits).
            onChange={(e) => setIdNumber(e.target.value.replace(/\D/g, '').slice(0, 12))}
          />
        </Field>
        <Field label="Correo (opcional)">
          <input type="email" maxLength={254} autoComplete="off" disabled={create.pending} value={email} onChange={(e) => setEmail(e.target.value)} />
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

// Logins, failed attempts (also of names that do not exist) and password
// changes and resets, newest first.
function LoginEventsPanel({ users }: { users: AdminUser[] }) {
  const [userId, setUserId] = useState('')
  const [type, setType] = useState<LoginEventType | ''>('')
  const [page, setPage] = useState(1)
  const query = `/users/login-events?page=${page}&pageSize=30${userId ? `&userId=${encodeURIComponent(userId)}` : ''}${type ? `&type=${type}` : ''}`
  const events = useLoad<Page<LoginEvent>>(query)

  return (
    <section className="card login-events">
      <h2 className="subtitle">Registro de ingresos</h2>
      <p className="field-hint">Ingresos, intentos fallidos (también con usuarios que no existen) y cambios de contraseña, del más reciente al más antiguo.</p>
      <div className="form-grid">
        <Field label="Usuario">
          <select value={userId} onChange={(e) => { setUserId(e.target.value); setPage(1) }}>
            <option value="">Todos</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.username})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Evento">
          <select value={type} onChange={(e) => { setType(e.target.value as LoginEventType | ''); setPage(1) }}>
            <option value="">Todos</option>
            {(Object.keys(LOGIN_EVENT_LABEL) as LoginEventType[]).map((t) => (
              <option key={t} value={t}>
                {LOGIN_EVENT_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {events.error ? <Notice kind="error">{events.error}</Notice> : null}
      {events.loading && !events.data ? <Loading label="Cargando registro…" /> : null}
      {events.data && events.data.items.length === 0 ? <p className="field-hint">Sin eventos con este filtro.</p> : null}
      {events.data && events.data.items.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Usuario</th>
                <th>Evento</th>
                <th>Desde</th>
              </tr>
            </thead>
            <tbody>
              {events.data.items.map((e) => (
                <tr key={e.id}>
                  <td data-label="Fecha">{formatDateTime(e.at)}</td>
                  <td data-label="Usuario">
                    {e.user ? e.user.name : <span className="muted">No existe</span>}
                    <span className="cell-sub mono">{e.identifier}</span>
                  </td>
                  <td data-label="Evento">
                    <span className={e.type === 'LOGIN_OK' || e.type === 'PASSWORD_CHANGED' ? 'badge' : 'badge badge-warning'}>{LOGIN_EVENT_LABEL[e.type]}</span>
                    {e.actor ? <span className="cell-sub">por {e.actor.name}</span> : null}
                  </td>
                  <td data-label="Desde">
                    {e.ip ?? '—'}
                    {e.userAgent ? <span className="cell-sub" title={e.userAgent}>{e.userAgent.slice(0, 60)}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {events.data && events.data.totalPages > 1 ? (
        <div className="actions">
          <button type="button" className="text-button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Más recientes
          </button>
          <span className="cell-sub">
            Página {events.data.page} de {events.data.totalPages}
          </span>
          <button type="button" className="text-button" disabled={page >= events.data.totalPages} onClick={() => setPage((p) => p + 1)}>
            Más antiguos
          </button>
        </div>
      ) : null}
    </section>
  )
}
