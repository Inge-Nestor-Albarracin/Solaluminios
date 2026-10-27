import { useState } from 'react'
import { describeError } from '../api/client'
import { formatDateTime } from '../lib/format'
import { useLoad } from '../lib/useLoad'
import { useSession } from '../session/session-context'
import { Notice } from './ui'

// Phase 2: links a fixed reader / portal of the dispatch location to this
// dispatch. The reader only MONITORS (detections and incidents through the
// same validation as the handheld); it never prepares, reserves or moves
// stock, and the exit is still confirmed on this screen.

interface ReaderOption {
  id: string
  code: string
  name: string
  simulator: boolean
  lastSeenAt: string | null
  sessions: { id: string; dispatch: { id: string; number: string } }[]
}

export function FixedReaderPanel({ dispatchId, onChanged }: { dispatchId: string; onChanged: () => void }) {
  const { request } = useSession()
  const enc = encodeURIComponent
  const options = useLoad<{ captureEnabled: boolean; readers: ReaderOption[] }>(`/dispatches/${enc(dispatchId)}/readers`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const act = async (path: string, body?: unknown) => {
    setBusy(true)
    setError(null)
    try {
      await request(path, { method: 'POST', body })
      options.reload()
      onChanged()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const readers = options.data?.readers ?? []
  // No fixed reader at this location: nothing to show (phase 1 only).
  if (readers.length === 0) return null

  return (
    <section className="card dispatch-reader">
      <h2 className="subtitle">Lector fijo / portal (monitoreo)</h2>
      <p className="field-hint">
        Registra detecciones e incidencias con las mismas reglas que la pistola. No prepara paquetes ni descuenta inventario: la salida se confirma
        aquí.
      </p>
      {options.data && !options.data.captureEnabled ? (
        <Notice kind="warning">La captura de lectores fijos está deshabilitada en el servidor; las lecturas del portal no se registrarán.</Notice>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <ul className="doc-list">
        {readers.map((reader) => {
          const session = reader.sessions[0]
          const mine = session?.dispatch.id === dispatchId
          return (
            <li key={reader.id} className="doc-row">
              <span>
                <strong>{reader.name}</strong> <span className="mono">{reader.code}</span>
                {reader.simulator ? <> <span className="badge badge-warning">Simulador</span></> : null}
                <small className="cell-sub">
                  {mine ? 'Sesión abierta con este despacho' : session ? `Ocupado con ${session.dispatch.number}` : 'Sin sesión'}
                  {reader.lastSeenAt ? ` · última lectura ${formatDateTime(reader.lastSeenAt)}` : ''}
                </small>
              </span>
              {mine ? (
                <button type="button" className="button button-secondary" disabled={busy} onClick={() => void act(`/reader-sessions/${enc(session.id)}/close`)}>
                  Cerrar sesión
                </button>
              ) : session ? null : (
                <button type="button" className="button" disabled={busy} onClick={() => void act(`/readers/${enc(reader.id)}/sessions`, { dispatchId })}>
                  Abrir sesión
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
