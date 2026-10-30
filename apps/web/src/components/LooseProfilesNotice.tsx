import { useRef, useState } from 'react'
import { ApiError, describeError } from '../api/client'
import { ORIGIN_LABEL, type DispatchDetail, type DispatchLine } from '../lib/commerce'
import { uuid } from '../lib/uuid'
import { useSession } from '../session/session-context'
import { Notice } from './ui'

// Prominent instruction of a dispatch when loose profiles (from opened
// bundles) are ASSIGNED to it: they are taken first, without reading chips.
// The quantities come from the dispatch's own reservations, never from a
// general balance another order could also use.
//   Case A — loose profiles cover the line: take them; no bundle is opened.
//   Case B — they cover part: take them first, then the rest from a bundle
//            (read it whole, or open it: its remainder stays loose).
export function LooseProfilesNotice({
  dispatch,
  executor,
  onChanged,
}: {
  dispatch: DispatchDetail
  executor: boolean
  onChanged: () => void
}) {
  const lines = dispatch.lines.filter((line) => line.loose.assigned > 0)
  if (dispatch.status !== 'OPEN' || lines.length === 0) return null
  return (
    <>
      {lines.map((line) => (
        <LooseLine key={line.id} dispatch={dispatch} line={line} executor={executor} onChanged={onChanged} />
      ))}
    </>
  )
}

function LooseLine({ dispatch, line, executor, onChanged }: { dispatch: DispatchDetail; line: DispatchLine; executor: boolean; onChanged: () => void }) {
  const { request } = useSession()
  const enc = encodeURIComponent
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  // One key per intended opening; kept while the outcome is unknown.
  const openKey = useRef<{ bundleId: string; key: string } | null>(null)
  const { toTake, prepared, missing, places } = line.loose
  const material = `${line.referenceCode}${line.referenceDescription ? ` — ${line.referenceDescription}` : ''}`
  const colour = line.finishDescription ?? line.finishCode
  const where = [dispatch.inventoryLocation.name, ...places].join(' · ')

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      setError(describeError(err))
      // The assignment changed or the answer is unknown: show the current state.
      if (err instanceof ApiError && (err.status === 409 || err.status === 0 || err.status >= 500)) onChanged()
    } finally {
      setBusy(false)
    }
  }

  // «Ya retiré los sueltos»: sends what the screen showed for this line.
  const takeLoose = () =>
    run(() => request(`/dispatches/${enc(dispatch.id)}/loose/prepare`, { method: 'POST', body: { lines: [{ dispatchLineId: line.id, quantity: line.loose.assigned }] } }))

  const openBundle = (bundleId: string) =>
    run(async () => {
      if (openKey.current?.bundleId !== bundleId) openKey.current = { bundleId, key: uuid() }
      try {
        await request(`/inventory/bundles/${enc(bundleId)}/open`, { method: 'POST', body: { operationKey: openKey.current.key } })
      } catch (err) {
        // Already opened (by us or someone else): continue with the loose profiles.
        if (!(err instanceof ApiError && err.status === 409 && /ya fue abierto/.test(describeError(err)))) throw err
      }
      openKey.current = null
      setOpening(null)
      await request(`/dispatches/${enc(dispatch.id)}/loose/refresh`, { method: 'POST' })
    })

  const facts = (
    <dl className="loose-facts">
      <div><dt>Referencia</dt><dd>{material}</dd></div>
      <div><dt>Color</dt><dd>{colour}</dd></div>
      <div><dt>Origen</dt><dd>{ORIGIN_LABEL[line.origin]}{line.supplierRequired ? ` · solo ${line.supplierRequired}` : ''}</dd></div>
      <div><dt>Dónde</dt><dd>En el almacén: {where}</dd></div>
    </dl>
  )

  return (
    <section className={`loose-notice ${missing > 0 ? 'loose-partial' : 'loose-complete'}`} aria-label={`Perfiles sueltos del renglón ${line.lineNo}`}>
      {toTake > 0 ? (
        missing === 0 ? (
          <>
            <p className="loose-headline">RETIRAR {toTake} PERFILES SUELTOS DEL ALMACÉN</p>
            <p className="loose-subline">NO ES NECESARIO ABRIR OTRO PAQUETE</p>
          </>
        ) : (
          <>
            <p className="loose-headline">USAR PRIMERO {toTake} PERFILES SUELTOS DEL ALMACÉN</p>
            <p className="loose-subline loose-missing">FALTAN {missing} PERFILES PARA COMPLETAR EL DESPACHO</p>
          </>
        )
      ) : (
        <>
          <p className="loose-headline">✓ {prepared} PERFILES SUELTOS PREPARADOS</p>
          {missing > 0 ? <p className="loose-subline loose-missing">FALTAN {missing} PERFILES PARA COMPLETAR EL DESPACHO</p> : null}
        </>
      )}
      {facts}

      {missing > 0 ? (
        <ol className="loose-steps">
          <li className={toTake === 0 ? 'done' : undefined}>
            <strong>Retirar los {toTake > 0 ? toTake : prepared} sueltos ya asignados</strong>
            {toTake === 0 ? ' — hecho.' : '.'}
          </li>
          <li>
            <strong>Obtener los {missing} restantes de un paquete</strong>: si está en otra bodega, trasládalo a este almacén y ábrelo aquí.
            {line.suggested.length > 0 ? (
              <ul className="loose-bundles">
                {line.suggested.map((s) => (
                  <li key={s.bundleId}>
                    <span>
                      <span className="mono">{s.epc}</span>
                      {s.aisle !== null ? ` · Pasillo ${s.aisle} · Burro ${s.rack}` : ''} — paquete de {s.bundleQuantity}:{' '}
                      {s.needsOpening ? (
                        <>ábrelo, usa {s.quantity} y quedan <strong>{s.bundleQuantity - s.quantity} sueltos</strong>.</>
                      ) : (
                        <>léelo completo con la pistola.</>
                      )}
                    </span>
                    {executor && s.needsOpening ? (
                      opening === s.bundleId ? (
                        <span className="actions">
                          <button type="button" className="button" disabled={busy} onClick={() => void openBundle(s.bundleId)}>
                            {busy ? 'Abriendo…' : `Confirmar: abrir paquete de ${s.bundleQuantity}`}
                          </button>
                          <button type="button" className="text-button" disabled={busy} onClick={() => setOpening(null)}>Volver</button>
                        </span>
                      ) : (
                        <button type="button" className="button button-secondary" disabled={busy} onClick={() => setOpening(s.bundleId)}>
                          Abrir paquete
                        </button>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        </ol>
      ) : null}

      {error ? <Notice kind="error">{error}</Notice> : null}
      {executor && toTake > 0 ? (
        <button type="button" className="button loose-take" disabled={busy} onClick={() => void takeLoose()}>
          {busy ? 'Registrando…' : `Ya retiré los ${toTake} sueltos`}
        </button>
      ) : null}
    </section>
  )
}
