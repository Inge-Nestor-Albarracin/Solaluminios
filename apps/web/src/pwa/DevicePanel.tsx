import { useEffect, useState, useSyncExternalStore } from 'react'
import { describeError } from '../api/client'
import { useSession } from '../session/session-context'
import { dismissInstall, promptInstall, useInstallState } from './install'
import {
  disablePush,
  enablePush,
  notificationPermission,
  pushAvailability,
  pushLinked,
  sendTestPush,
  serverPushConfig,
  setPushLinked,
  subscribePushLinked,
} from './push'

// «Este dispositivo» on the home screen: install the app (only when the
// browser offers it) and turn notifications on/off for this device.
export function DevicePanel() {
  const { request } = useSession()
  const install = useInstallState()
  const linked = useSyncExternalStore(subscribePushLinked, pushLinked)
  const availability = pushAvailability()
  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null)
  const [permission, setPermission] = useState(notificationPermission)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (availability !== 'supported') return
    let cancelled = false
    serverPushConfig(request)
      .then((config) => !cancelled && setServerEnabled(config.enabled))
      .catch(() => !cancelled && setServerEnabled(null))
    return () => {
      cancelled = true
    }
  }, [availability, request])

  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      await action()
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      setMessage({
        kind: 'error',
        text:
          code === 'server-disabled'
            ? 'Las notificaciones no están configuradas en el servidor.'
            : code === 'no-worker'
              ? 'La aplicación aún no terminó de prepararse en este dispositivo. Inténtalo de nuevo en unos segundos.'
              : describeError(error),
      })
    } finally {
      setBusy(false)
      setPermission(notificationPermission())
    }
  }

  const activate = () =>
    run(async () => {
      const result = await enablePush(request)
      if (result === 'on') {
        setPushLinked(true)
        setMessage({ kind: 'ok', text: 'Notificaciones activadas en este dispositivo.' })
      } else if (result === 'denied') {
        setMessage({ kind: 'error', text: 'Rechazaste el permiso. No lo volveremos a pedir; puedes permitirlo en la configuración del sitio del navegador.' })
      } else {
        setMessage({ kind: 'error', text: 'No se concedió el permiso de notificaciones.' })
      }
    })

  const deactivate = () =>
    run(async () => {
      await disablePush(request)
      setPushLinked(false)
      setMessage({ kind: 'ok', text: 'Notificaciones desactivadas en este dispositivo. Tus otros dispositivos no cambian.' })
    })

  const test = () =>
    run(async () => {
      const report = await sendTestPush(request)
      setMessage({
        kind: report.delivered > 0 ? 'ok' : 'error',
        text:
          report.delivered > 0
            ? `Notificación de prueba enviada a ${report.delivered} ${report.delivered === 1 ? 'dispositivo' : 'dispositivos'}. Puede tardar unos segundos.`
            : 'El servicio de notificaciones no aceptó el envío. Desactiva y vuelve a activar las notificaciones.',
      })
      if (report.removed > 0 && report.delivered === 0) setPushLinked(false)
    })

  let status: string
  let actions: 'activate' | 'on' | null = null
  if (availability === 'insecure') status = 'Requieren una conexión segura (HTTPS). Abre la aplicación desde su dirección https://.'
  else if (availability === 'unsupported') status = 'Este navegador no admite notificaciones push. En Android usa Google Chrome.'
  else if (availability === 'no-worker') status = 'Disponibles en la versión compilada de la aplicación (no en modo de desarrollo).'
  else if (serverEnabled === false) status = 'No están configuradas en el servidor.'
  else if (permission === 'denied') status = 'Bloqueadas en este navegador. Para recibirlas, permite las notificaciones en la configuración del sitio.'
  else if (linked) {
    status = 'Activadas en este dispositivo. Recibirás un aviso cuando te asignen una tarea.'
    actions = 'on'
  } else if (linked === false || serverEnabled) {
    status = 'Desactivadas en este dispositivo.'
    actions = 'activate'
  } else status = 'Comprobando…'

  return (
    <section className="device-panel card" aria-labelledby="device-title">
      <h2 id="device-title" className="subtitle">Este dispositivo</h2>

      {install !== 'unavailable' ? (
        <div className="device-row">
          <div>
            <strong>Aplicación</strong>
            <small>{install === 'installed' ? 'Instalada: ábrela desde el ícono de la pantalla de inicio.' : 'Puedes instalarla para abrirla como una app, sin barra del navegador.'}</small>
          </div>
          {install === 'available' ? (
            <div className="device-actions">
              <button type="button" className="button button-secondary" onClick={() => void promptInstall()}>
                Instalar aplicación
              </button>
              <button type="button" className="text-button" onClick={dismissInstall}>
                Ahora no
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="device-row">
        <div>
          <strong>Notificaciones</strong>
          <small>{status}</small>
        </div>
        {actions ? (
          <div className="device-actions">
            {actions === 'activate' ? (
              <button type="button" className="button button-secondary" disabled={busy} onClick={() => void activate()}>
                {busy ? 'Activando…' : 'Activar notificaciones'}
              </button>
            ) : (
              <>
                <button type="button" className="button button-secondary" disabled={busy} onClick={() => void test()}>
                  Enviar notificación de prueba
                </button>
                <button type="button" className="text-button" disabled={busy} onClick={() => void deactivate()}>
                  Desactivar
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
      {message ? (
        <p className={message.kind === 'ok' ? 'device-message' : 'device-message device-message-error'} role={message.kind === 'ok' ? 'status' : 'alert'}>
          {message.text}
        </p>
      ) : null}
    </section>
  )
}
