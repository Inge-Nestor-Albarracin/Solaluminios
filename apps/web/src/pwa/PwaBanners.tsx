import { useState } from 'react'
import { useConnectivity } from './connectivity'
import { applyUpdate, postponeUpdate, reloadNow, useUpdateState } from './serviceWorker'
import { localBlockers, otherWindowsBlockers, useLocalBlockers } from './workGuard'

// Connection notice: shown while the device has no network or the API does
// not answer. It explains what needs a connection; nothing is queued.
function OfflineBanner() {
  const connectivity = useConnectivity()
  const [details, setDetails] = useState(false)
  if (connectivity === 'online') return null
  return (
    <div className="pwa-banner pwa-banner-offline" role="status" aria-live="polite">
      <div className="pwa-banner-text">
        <strong>{connectivity === 'offline' ? 'Sin conexión' : 'Sin conexión con el servidor'}</strong>
        <span>
          Consultar y guardar necesitan conexión. Lo que ves puede no estar actualizado.{' '}
          <button type="button" className="link" aria-expanded={details} onClick={() => setDetails((open) => !open)}>
            {details ? 'Ocultar' : '¿Qué puedo hacer?'}
          </button>
        </span>
        {details ? (
          <ul>
            <li>Registrar paquetes, salidas, traslados, ajustes y tareas requieren conexión: nada se envía ni se guarda después de forma automática.</li>
            <li>Una operación sin respuesta del servidor queda sin confirmar; al volver la conexión revisa el historial y reintenta con el mismo botón (no se aplica dos veces).</li>
            <li>Los datos que escribiste se conservan en el formulario y la lista de registro pendiente sigue en esta pestaña.</li>
            <li>La lectura masiva sigue recibiendo chips de la pistola, pero su referencia se consulta cuando vuelva la conexión.</li>
          </ul>
        ) : null}
      </div>
    </div>
  )
}

// New version: never reloads by itself. «Actualizar» first checks for work
// that a reload would interrupt, here and in the other windows of the app.
function UpdateBanner() {
  const update = useUpdateState()
  const local = useLocalBlockers()
  const [checking, setChecking] = useState(false)
  const [blocked, setBlocked] = useState<{ here: string[]; elsewhere: string[] } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [hidden, setHidden] = useState(false)

  if (update === 'none' || hidden) return null

  const check = async () => {
    setChecking(true)
    const elsewhere = update === 'activated-elsewhere' ? [] : await otherWindowsBlockers()
    const here = localBlockers()
    setChecking(false)
    if (here.length > 0 || elsewhere.length > 0) {
      setBlocked({ here, elsewhere })
      setConfirming(false)
      return false
    }
    setBlocked(null)
    return true
  }

  const proceed = async () => {
    // Checked again: something may have started while confirming.
    if (!(await check())) return
    if (update === 'activated-elsewhere') reloadNow()
    else applyUpdate()
  }

  const later = () => {
    setBlocked(null)
    setConfirming(false)
    if (update === 'available') postponeUpdate()
    else setHidden(true)
  }

  const title =
    update === 'activated-elsewhere'
      ? 'Se activó una versión nueva desde otra ventana'
      : update === 'applying'
        ? 'Actualizando…'
        : 'Hay una versión nueva de la aplicación'

  return (
    <div className="pwa-banner pwa-banner-update" role="status" aria-live="polite">
      <div className="pwa-banner-text">
        <strong>{title}</strong>
        {blocked ? (
          <>
            <span>Antes de actualizar, termina o cancela:</span>
            <ul>
              {blocked.here.map((reason) => <li key={`h-${reason}`}>{reason}</li>)}
              {blocked.elsewhere.map((reason) => <li key={`o-${reason}`}>{reason} (en otra ventana)</li>)}
            </ul>
          </>
        ) : confirming ? (
          <span>La aplicación se recargará y deberás iniciar sesión de nuevo. Las otras ventanas no se recargan.</span>
        ) : update === 'activated-elsewhere' ? (
          <span>Esta ventana sigue con la versión anterior; recárgala cuando termines lo que estás haciendo.</span>
        ) : update === 'available' ? (
          <span>
            Se instalará cuando lo confirmes{local.length > 0 ? '; primero termina el trabajo en curso' : ''}.
          </span>
        ) : null}
      </div>
      {update !== 'applying' ? (
        <div className="pwa-banner-actions">
          {confirming ? (
            <button type="button" className="button" disabled={checking} onClick={() => void proceed()}>
              {update === 'activated-elsewhere' ? 'Recargar ahora' : 'Actualizar ahora'}
            </button>
          ) : (
            <button
              type="button"
              className="button"
              disabled={checking}
              onClick={() => void check().then((ok) => setConfirming(ok))}
            >
              {checking ? 'Comprobando…' : blocked ? 'Comprobar de nuevo' : update === 'activated-elsewhere' ? 'Recargar' : 'Actualizar'}
            </button>
          )}
          <button type="button" className="button button-secondary" onClick={later}>
            Más tarde
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function PwaBanners() {
  return (
    <div className="pwa-banners">
      <OfflineBanner />
      <UpdateBanner />
    </div>
  )
}
