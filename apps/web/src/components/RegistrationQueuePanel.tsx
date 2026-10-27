import { useState } from 'react'
import type { Bundle } from '../api/types'
import { MAX_QUEUE_SIZE, type QueueItem, type StorageStatus } from '../lib/registrationQueue'
import { IconCheck, IconClose } from './icons'
import { Notice } from './ui'

const number = new Intl.NumberFormat('es-CO')

// List of bundles waiting for the final save, with a visible confirmation
// step before anything is written to the inventory. Conflicting items are
// marked and linked to the existing bundle; removing them is the user's call.
export function RegistrationQueuePanel({
  items,
  storage,
  saving,
  saveError,
  problemEpcs,
  conflicts,
  saved,
  onRemove,
  onClear,
  onSave,
  onOpen,
  onViewExisting,
}: {
  items: QueueItem[]
  storage: StorageStatus
  saving: boolean
  saveError: string | null
  problemEpcs: string[]
  conflicts: string[]
  saved: { replayed: boolean; count: number; bundles: Bundle[] } | null
  onRemove: (id: string) => void
  onClear: () => void
  onSave: () => Promise<boolean>
  onOpen: (bundleId: string) => void
  onViewExisting: (epc: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const profiles = items.reduce((sum, item) => sum + item.body.quantity, 0)

  const save = async () => {
    const ok = await onSave()
    if (ok) setConfirming(false)
  }

  return (
    <section id="registration-queue" className="queue-panel" aria-label="Lista por guardar">
      <header className="queue-head">
        <div>
          <p className="eyebrow">Lista por guardar</p>
          <h2>
            {items.length} {items.length === 1 ? 'paquete' : 'paquetes'}
            {items.length > 0 ? <span className="badge badge-warning">Sin guardar</span> : null}
            <small>
              {number.format(profiles)} {profiles === 1 ? 'perfil' : 'perfiles'} · máx. {MAX_QUEUE_SIZE}
            </small>
          </h2>
        </div>
        {items.length > 0 && !confirming ? (
          confirmClear ? (
            <span className="queue-clear-confirm">
              <button
                type="button"
                className="text-button danger"
                onClick={() => {
                  onClear()
                  setConfirmClear(false)
                }}
              >
                Sí, vaciar
              </button>
              <button type="button" className="text-button" onClick={() => setConfirmClear(false)}>
                No
              </button>
            </span>
          ) : (
            <button type="button" className="text-button" disabled={saving} onClick={() => setConfirmClear(true)}>
              Vaciar lista
            </button>
          )
        ) : null}
      </header>

      {storage === 'unavailable' ? (
        <Notice kind="warning">
          Este navegador no permite conservar la lista: si recargas, cierras la pestaña o cierras sesión, se perderá.
          Guárdala antes de salir.
        </Notice>
      ) : null}

      {saved ? (
        <Notice kind="success">
          <strong>
            {saved.replayed
              ? `La lista ya estaba guardada (${saved.count} ${saved.count === 1 ? 'paquete' : 'paquetes'}); el reintento no duplicó nada.`
              : `${saved.count} ${saved.count === 1 ? 'paquete guardado' : 'paquetes guardados'} en el inventario.`}
          </strong>
          <ul className="saved-list">
            {saved.bundles.map((bundle) => (
              <li key={bundle.id}>
                <button type="button" className="link mono" onClick={() => onOpen(bundle.id)}>
                  {bundle.epc}
                </button>{' '}
                · {bundle.reference.code} · {bundle.finish.code} · {bundle.quantity}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {saveError ? (
        <Notice kind="error">
          {saveError}
          {conflicts.length > 0 ? (
            <p className="notice-detail">
              Revisa en la lista {conflicts.length === 1 ? 'el chip marcado' : 'los chips marcados'}: puedes ver el paquete
              existente y decidir si quitarlo de la lista.
            </p>
          ) : null}
        </Notice>
      ) : null}

      {items.length === 0 ? (
        <p className="queue-empty">
          Aún no hay paquetes en la lista. Completa el formulario y pulsa «Guardar y continuar».
        </p>
      ) : (
        <ol className="queue-list">
          {items.map((item, index) => {
            const conflict = conflicts.includes(item.body.epc)
            const problem = conflict || problemEpcs.includes(item.body.epc)
            return (
              <li key={item.id} className={problem ? 'queue-item problem' : 'queue-item'}>
                <span className="queue-index" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className="queue-info">
                  <strong className="mono">{item.body.epc}</strong>
                  <span>
                    {item.labels.reference} · {item.labels.finish}{item.labels.origin ? ` · ${item.labels.origin}` : ''}
                  </span>
                  <span className="queue-meta">
                    {item.body.quantity} {item.body.quantity === 1 ? 'perfil' : 'perfiles'} · {item.labels.location} ·{' '}
                    {item.labels.type} · Llegada: {item.labels.arrival}
                  </span>
                  {conflict ? (
                    <span className="queue-conflict">
                      Este chip ya está registrado en el inventario.{' '}
                      <button type="button" className="link" onClick={() => onViewExisting(item.body.epc)}>
                        Ver el paquete existente
                      </button>
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="icon-button queue-remove"
                  aria-label={`Quitar el chip ${item.body.epc} de la lista`}
                  title="Quitar de la lista"
                  disabled={saving || confirming}
                  onClick={() => onRemove(item.id)}
                >
                  <IconClose />
                </button>
              </li>
            )
          })}
        </ol>
      )}

      {items.length > 0 ? (
        <footer className="queue-footer">
          {confirming ? (
            <div className="confirm" role="alertdialog" aria-label="Confirmar guardado definitivo">
              <p>
                Se guardarán <strong>{items.length}</strong> {items.length === 1 ? 'paquete' : 'paquetes'} con{' '}
                <strong>{number.format(profiles)}</strong> perfiles y su movimiento inicial. Se guardan todos juntos: si
                uno falla, no se guarda ninguno.
              </p>
              <div className="actions">
                <button type="button" className="button" disabled={saving} onClick={save}>
                  <IconCheck />
                  {saving ? 'Guardando…' : 'Confirmar guardado'}
                </button>
                <button type="button" className="button button-secondary" disabled={saving} onClick={() => setConfirming(false)}>
                  Volver
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="button queue-save" disabled={saving} onClick={() => setConfirming(true)}>
              <IconCheck />
              Guardar definitivo ({items.length})
            </button>
          )}
        </footer>
      ) : null}
    </section>
  )
}
