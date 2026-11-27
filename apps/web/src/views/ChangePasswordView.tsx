import { useState, type FormEvent } from 'react'
import { describeError } from '../api/client'
import { BrandLogo } from '../components/brand/BrandLogo'
import { Field, Notice, PageHeader } from '../components/ui'
import { passwordRules } from '../lib/passwords'
import { useSession } from '../session/session-context'
import './LoginView.css'

// `forced`: first login with the initial password (the ID number); nothing
// else of the app is available until it is changed.
export function ChangePasswordView({ forced, onDone }: { forced?: boolean; onDone?: () => void }) {
  const { user, changePassword, logout } = useSession()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [show, setShow] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const rules = passwordRules(next, user?.username ?? '', current)
  const blocker = !current
    ? forced
      ? 'escribe tu contraseña actual (tu cédula)'
      : 'escribe tu contraseña actual'
    : rules.some((rule) => !rule.ok)
      ? 'la nueva contraseña no cumple las reglas'
      : next !== repeat
        ? 'repite la nueva contraseña igual'
        : null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending || blocker) return
    setPending(true)
    setError(null)
    try {
      await changePassword(current, next)
      setCurrent('')
      setNext('')
      setRepeat('')
      setDone(true)
      onDone?.()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setPending(false)
    }
  }

  const form = (
    <form onSubmit={submit} className="password-form" aria-busy={pending}>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {done && !forced ? <Notice kind="success">Contraseña cambiada. Úsala desde tu próximo ingreso.</Notice> : null}
      <Field label={forced ? 'Contraseña actual (tu cédula)' : 'Contraseña actual'}>
        <input
          type={show ? 'text' : 'password'}
          autoComplete="current-password"
          value={current}
          disabled={pending}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field label="Nueva contraseña">
        <input type={show ? 'text' : 'password'} autoComplete="new-password" value={next} disabled={pending} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Repite la nueva contraseña">
        <input type={show ? 'text' : 'password'} autoComplete="new-password" value={repeat} disabled={pending} onChange={(e) => setRepeat(e.target.value)} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
        <span>Mostrar las contraseñas</span>
      </label>
      <ul className="password-rules" aria-live="polite">
        {rules.map((rule) => (
          <li key={rule.text} className={rule.ok ? 'ok' : ''}>
            {rule.ok ? '✓' : '·'} {rule.text}
          </li>
        ))}
      </ul>
      <div className="actions">
        <button type="submit" className="button" disabled={pending || blocker !== null}>
          {pending ? 'Guardando…' : 'Cambiar contraseña'}
        </button>
        {forced ? (
          <button type="button" className="text-button" disabled={pending} onClick={() => logout()}>
            Salir
          </button>
        ) : null}
        {blocker && !pending ? <span className="cell-sub save-blocker">Para guardar: {blocker}</span> : null}
      </div>
    </form>
  )

  if (!forced) {
    return (
      <>
        <PageHeader
          eyebrow="Mi cuenta"
          title="Cambiar mi contraseña"
          description={`Usuario: ${user?.username ?? ''}. Al cambiarla, tus otras sesiones abiertas (en otros equipos) se cierran.`}
        />
        <section className="card">{form}</section>
      </>
    )
  }

  return (
    <main className="login-shell">
      <span className="login-pill login-pill-1" aria-hidden="true" />
      <span className="login-pill login-pill-2" aria-hidden="true" />
      <div className="login-column">
        <BrandLogo className="login-logo" variant="full" tone="negative" />
        <section className="login-card password-card" aria-labelledby="password-title">
          <h1 id="password-title" className="login-lead">
            Hola, {user?.name}. Es tu primer ingreso
          </h1>
          <p className="login-help">
            Tu contraseña inicial es tu número de cédula, y esa la conocen otras personas. Cámbiala por una propia para poder usar la aplicación.
          </p>
          {form}
        </section>
      </div>
    </main>
  )
}
