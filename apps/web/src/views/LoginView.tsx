import { useState, type FormEvent } from 'react'
import { describeError } from '../api/client'
import { BrandLogo } from '../components/brand/BrandLogo'
import { Notice } from '../components/ui'
import { useSession } from '../session/session-context'
import './LoginView.css'

// Login from the WeTracking app design (v.03): brand-blue background, negative
// logo, white card with "¡Bienvenido!", grey fields and a navy pill button.
export function LoginView() {
  const { login, notice } = useSession()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await login(username.trim().toLowerCase(), password)
    } catch (err) {
      setError(describeError(err))
      setPending(false)
    }
  }

  return (
    <main className="login-shell">
      <span className="login-pill login-pill-1" aria-hidden="true" />
      <span className="login-pill login-pill-2" aria-hidden="true" />
      <span className="login-pill login-pill-3" aria-hidden="true" />

      <div className="login-column">
        <BrandLogo className="login-logo" variant="full" tone="negative" />

        <section className="login-card" aria-labelledby="login-welcome">
          <p className="login-lead">Ingresa tus datos para comenzar</p>

          <form onSubmit={submit} aria-labelledby="login-welcome" aria-busy={pending}>
            {notice ? <Notice kind="warning">{notice}</Notice> : null}
            {error ? <Notice kind="error">{error}</Notice> : null}

            <div className="login-field">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.4 0-8 2.5-8 5.5V21h16v-1.5c0-3-3.6-5.5-8-5.5Z" />
              </svg>
              <input
                id="login-username"
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder=" "
                required
                disabled={pending}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <label htmlFor="login-username">Usuario (p. ej. pedro.alvarez)</label>
            </div>

            <div className="login-field">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Zm3 3.5a1.5 1.5 0 0 1 .8 2.8V18h-1.6v-1.7a1.5 1.5 0 0 1 .8-2.8Z" />
              </svg>
              <input
                id="login-password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder=" "
                required
                disabled={pending}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <label htmlFor="login-password">Contraseña</label>
              <button
                className="login-visibility"
                type="button"
                aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                aria-controls="login-password"
                aria-pressed={showPassword}
                onClick={() => setShowPassword((visible) => !visible)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                  <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
                  <circle cx="12" cy="12" r="3" fill="currentColor" />
                  {showPassword ? <path d="m3 3 18 18" /> : null}
                </svg>
              </button>
            </div>

            <button type="submit" className="login-submit" disabled={pending}>
              {pending ? <span className="login-progress" aria-hidden="true" /> : null}
              <span aria-live="polite">{pending ? 'Ingresando…' : 'Iniciar sesión'}</span>
            </button>
          </form>

          <p className="login-help">
            ¿Primer ingreso? Tu contraseña es tu número de cédula; al entrar te pedirá cambiarla. ¿La olvidaste o necesitas acceso? Consulta con tu
            administrador.
          </p>
          <p className="login-session-note">Al recargar o cerrar esta página, tendrás que ingresar de nuevo.</p>
        </section>

        <footer className="login-footer">
          <span>Inventario · Solualuminios</span>
        </footer>
      </div>
    </main>
  )
}
