import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, describeError } from '../api/client'
import { FixedReaderPanel } from '../components/FixedReaderPanel'
import { IconScan } from '../components/icons'
import { LooseProfilesNotice } from '../components/LooseProfilesNotice'
import { Field, Kpi, Loading, Notice, PageHeader } from '../components/ui'
import type { TagRead } from '../lib/chafon'
import { DISPATCH_STATUS_LABEL, ORIGIN_LABEL, type DispatchDetail } from '../lib/commerce'
import { formatDateTime } from '../lib/format'
import { useChafonReader } from '../lib/useChafonReader'
import { useLoad } from '../lib/useLoad'
import { uuid } from '../lib/uuid'
import { useUnsavedWork } from '../pwa/workGuard'
import { useSession } from '../session/session-context'
import type { Navigate } from './navigation'

// Dispatch preparation with the handheld (phase 1). Every chip is validated
// by the API against the dispatch: matching bundles are prepared with an
// explicit quantity, mismatches open an incident (on screen + sound + push to
// the assignee and supervisor). Preparing is not dispatching: the stock only
// leaves with «Confirmar salida física».

interface ScanResult {
  result: 'PREPARED' | 'ALREADY_PREPARED' | 'LINE_COMPLETE' | 'INCIDENT' | 'MATCH' | 'OPENED' | 'LOOSE_FIRST'
  epc: string
  message: string
  quantity?: number
}

const RESEND_MS = 4000

function beep() {
  try {
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return
    const context = new AudioContextClass()
    const oscillator = context.createOscillator()
    oscillator.type = 'square'
    oscillator.frequency.value = 520
    oscillator.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.35)
    oscillator.onended = () => void context.close()
  } catch {
    // Sound is an extra; the alert is on screen.
  }
}

// `onChanged`: the dispatch task was completed, cancelled or reassigned (the
// pending-tasks badge depends on it).
export function DispatchView({ id, navigate, onChanged }: { id: string; navigate: Navigate; onChanged?: () => void }) {
  const { request, user } = useSession()
  const enc = encodeURIComponent
  const detail = useLoad<DispatchDetail>(`/dispatches/${enc(id)}`)
  const [results, setResults] = useState<ScanResult[]>([])
  const [manual, setManual] = useState('')
  const [sound, setSound] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [resolving, setResolving] = useState<Record<string, string>>({})
  const confirmKey = useRef<string | null>(null)
  const [manage, setManage] = useState<{ kind: 'cancel' | 'reassign'; reason: string; assigneeId: string } | null>(null)
  // Chips already sent recently: the reader repeats the same tag many times
  // per second; each one is validated once (the API ignores repeats anyway).
  const sentAt = useRef(new Map<string, number>())
  const queue = useRef<string[]>([])
  const draining = useRef(false)
  const data = detail.data
  const executor = user?.role === 'ADMIN' || user?.role === 'WAREHOUSE'
  const manager = user?.role === 'ADMIN' || user?.role === 'SALES'
  const open = data?.status === 'OPEN'
  const assignees = useLoad<{ id: string; name: string }[]>(
    manage?.kind === 'reassign' && data ? `/dispatches/eligible-assignees?inventoryLocationId=${enc(data.inventoryLocation.id)}` : null,
  )

  const drain = useCallback(async () => {
    if (draining.current) return
    draining.current = true
    try {
      while (queue.current.length > 0) {
        const epc = queue.current.shift()!
        try {
          const { data: result } = await request<ScanResult>(`/dispatches/${enc(id)}/scan`, { method: 'POST', body: { epc } })
          setResults((current) => [result, ...current].slice(0, 30))
          if (result.result === 'INCIDENT') {
            if (sound) beep()
            navigator.vibrate?.([200, 80, 200])
          }
        } catch (err) {
          setResults((current) => [{ result: 'INCIDENT' as const, epc, message: describeError(err) }, ...current].slice(0, 30))
          sentAt.current.delete(epc)
        }
      }
    } finally {
      draining.current = false
      detail.reload()
    }
  }, [detail, enc, id, request, sound])

  const submitEpc = useCallback(
    (raw: string) => {
      const epc = raw.trim().toUpperCase()
      if (!/^[A-Z0-9]{1,128}$/.test(epc)) return
      const last = sentAt.current.get(epc)
      if (last && Date.now() - last < RESEND_MS) return
      sentAt.current.set(epc, Date.now())
      queue.current.push(epc)
      void drain()
    },
    [drain],
  )

  const onTag = useCallback((tag: TagRead) => submitEpc(tag.epc), [submitEpc])
  const reader = useChafonReader(onTag)

  useUnsavedWork(
    reader.reading || reader.trigger
      ? 'Lectura RFID de un despacho en curso'
      : reader.status === 'connected'
        ? 'Pistola RFID conectada a un despacho'
        : uncertain
          ? 'Confirmación de despacho con resultado sin verificar'
          : Object.keys(edits).length > 0
            ? 'Cantidades de despacho sin aplicar'
            : null,
  )

  // When its executor opens it, the server applies «loose first» again:
  // loose profiles that appeared since (an opened bundle) replace closed
  // bundles not read yet. Once per dispatch shown.
  const refreshed = useRef(false)
  useEffect(() => {
    if (!open || !executor || refreshed.current) return
    refreshed.current = true
    request(`/dispatches/${enc(id)}/loose/refresh`, { method: 'POST' })
      .then(() => detail.reload())
      .catch(() => undefined) // The detail already shows the current state.
  }, [open, executor, request, enc, id, detail])

  // Refreshes the open dispatch every 20 s while visible (incidents from a
  // portal, reassignments). The stock rules never depend on this screen.
  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !draining.current) detail.reload()
    }, 20_000)
    return () => window.clearInterval(timer)
  }, [open, detail])

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      detail.reload()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const setPick = (bundleId: string, quantity: number) =>
    act(async () => {
      await request(`/dispatches/${enc(id)}/picks/${enc(bundleId)}`, { method: 'PATCH', body: { quantity } })
      setEdits((current) => {
        const next = { ...current }
        delete next[bundleId]
        return next
      })
    })

  const confirm = async () => {
    setBusy(true)
    setError(null)
    confirmKey.current ??= uuid()
    try {
      await request(`/dispatches/${enc(id)}/confirm`, { method: 'POST', body: { operationKey: confirmKey.current } })
      confirmKey.current = null
      setUncertain(false)
      setConfirming(false)
      if (reader.status === 'connected') await reader.disconnect()
      detail.reload()
      onChanged?.()
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      const retryable = err instanceof ApiError && (err.data as { retryable?: boolean } | null)?.retryable === true
      if (status === 0 || (status >= 500 && !retryable)) {
        // Unknown outcome: same key for the retry (never applied twice).
        setUncertain(true)
        setError('No se recibió respuesta del servidor: la salida pudo haberse registrado. Pulsa de nuevo «Confirmar salida física»; no se descontará dos veces.')
      } else {
        if (!retryable) confirmKey.current = null
        setError(describeError(err))
      }
      detail.reload()
    } finally {
      setBusy(false)
    }
  }

  const submitManual = (event: FormEvent) => {
    event.preventDefault()
    for (const code of manual.split(/[\s,;]+/)) submitEpc(code)
    setManual('')
  }

  if (detail.loading && !data) return <Loading />
  if (detail.error && !data) return <Notice kind="error">{detail.error}</Notice>
  if (!data) return null

  const openIncidents = data.incidents.filter((incident) => incident.status === 'OPEN')

  return (
    <>
      <PageHeader
        eyebrow={`Despacho · ${DISPATCH_STATUS_LABEL[data.status]}`}
        title={data.number}
        description={`Orden ${data.salesOrder.number} · ${data.salesOrder.customerName} · sale de ${data.inventoryLocation.name} · responsable ${data.assignee.name} · plazo ${formatDateTime(data.dueAt)}`}
        actions={
          <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'dispatches' })}>
            Despachos
          </button>
        }
      />
      {data.progress.overdue ? <Notice kind="warning">Despacho atrasado: sigue pendiente; el plazo vencido no libera reservas ni confirma nada.</Notice> : null}
      {data.status === 'CONFIRMED' ? <Notice kind="success">Salida confirmada {data.confirmedAt ? formatDateTime(data.confirmedAt) : ''}{data.confirmedBy ? ` por ${data.confirmedBy.name}` : ''}.</Notice> : null}
      {data.status === 'CANCELLED' ? <Notice kind="warning">Despacho cancelado: {data.cancelReason}</Notice> : null}

      {/* Main instruction first: loose profiles assigned to this dispatch. */}
      <LooseProfilesNotice dispatch={data} executor={open && executor} onChanged={detail.reload} />

      <div className="kpis">
        <Kpi label="Autorizado" value={data.progress.authorised} hint="perfiles" dark />
        <Kpi label="Preparado" value={data.progress.prepared} hint="perfiles" />
        <Kpi label="Entregado" value={data.progress.dispatched} hint="perfiles" />
        <Kpi label="Incidencias" value={data.progress.openIncidents} hint="abiertas" />
      </div>


      {data.lines.map((line) => (
        <section key={line.id} className="card dispatch-line">
          <header className="dispatch-line-head">
            <strong>
              {line.authorised} perfiles · {line.referenceCode} {line.finishDescription ?? line.finishCode}
            </strong>
            <span className={`badge ${line.origin === 'CHINA' ? 'badge-china' : 'badge-national'}`}>
              {ORIGIN_LABEL[line.origin]}{line.supplierRequired ? ` · solo ${line.supplierRequired}` : ''}
            </span>
            <small>{data.status === 'CANCELLED' ? 'Sin salida' : line.pending > 0 ? `Faltan ${line.pending}` : 'Completo'}</small>
          </header>
          {line.picks.length > 0 ? (
            <ul className="pick-list">
              {line.picks.map((pick) => (
                <li key={pick.bundleId}>
                  {pick.loose ? <strong>Sueltos del almacén</strong> : <span className="mono">{pick.epc}</span>}
                  <small>
                    {pick.origin ? ORIGIN_LABEL[pick.origin] : '—'}{pick.supplier ? ` · ${pick.supplier}` : ''} · lote {pick.lot ?? '—'}
                    {pick.aisle !== null ? ` · P${pick.aisle}/B${pick.rack}` : ''}
                    {pick.loose ? ` · paquete abierto ${pick.epc}` : ` · paquete de ${pick.bundleQuantity}`}
                  </small>
                  {open && executor ? (
                    <span className="pick-qty">
                      <input
                        type="number"
                        min={0}
                        max={pick.bundleQuantity}
                        aria-label={`Perfiles del paquete ${pick.epc}`}
                        value={edits[pick.bundleId] ?? String(pick.quantity)}
                        onChange={(e) => {
                          // Back to the saved value: nothing left to apply.
                          const { [pick.bundleId]: _previous, ...rest } = edits
                          setEdits(e.target.value === String(pick.quantity) ? rest : { ...rest, [pick.bundleId]: e.target.value })
                        }}
                      />
                      {edits[pick.bundleId] !== undefined ? (
                        <button type="button" className="text-button" disabled={busy} onClick={() => void setPick(pick.bundleId, Number(edits[pick.bundleId]))}>Aplicar</button>
                      ) : null}
                      <button type="button" className="text-button danger" disabled={busy} onClick={() => void setPick(pick.bundleId, 0)}>Quitar</button>
                    </span>
                  ) : (
                    <strong>{pick.quantity}</strong>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {open && line.suggested.length > 0 ? (
            <p className="field-hint">
              Sugeridos: {line.suggested.map((s) => `${s.epc}${s.aisle !== null ? ` (P${s.aisle}/B${s.rack})` : ''} ${s.quantity}`).join(' · ')}
            </p>
          ) : null}
        </section>
      ))}

      {open && executor ? (
        <section className="card dispatch-reader">
          <h2 className="subtitle">Leer paquetes</h2>
          <div className="actions">
            {reader.status === 'unsupported' ? (
              <span className="field-hint">Bluetooth no disponible en este navegador: usa la pistola en modo teclado.</span>
            ) : reader.status === 'connected' ? (
              <>
                {reader.reading ? (
                  <button type="button" className="button" onClick={() => void reader.stop()}>Detener lectura</button>
                ) : (
                  <button type="button" className="button" onClick={() => void reader.start()}>Iniciar lectura</button>
                )}
                <button type="button" className="button button-secondary" onClick={() => void reader.disconnect()}>Desconectar</button>
              </>
            ) : reader.canReconnect ? (
              <>
                <button type="button" className="button" disabled={reader.status === 'connecting'} onClick={() => void reader.reconnect()}>Reconectar pistola</button>
                <button type="button" className="button button-secondary" onClick={() => void reader.connect()}>Elegir otro lector</button>
              </>
            ) : (
              <button type="button" className="button" disabled={reader.status === 'connecting'} onClick={() => void reader.connect()}>
                {reader.status === 'connecting' ? 'Conectando…' : 'Conectar pistola Bluetooth'}
              </button>
            )}
            <label className="check">
              <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Sonido en incidencias
            </label>
          </div>
          {reader.error ? <Notice kind="error">{reader.error}</Notice> : null}
          <form onSubmit={submitManual}>
            <Field label="Chip (modo teclado o manual)">
              <span className="input-wrap">
                <IconScan />
                <input className="mono" value={manual} autoComplete="off" spellCheck={false} onChange={(e) => setManual(e.target.value)} placeholder="E280…" />
              </span>
            </Field>
          </form>
          <ul className="scan-feed" aria-live="polite">
            {results.map((result, index) => (
              <li key={`${result.epc}-${index}`} className={`scan-${result.result.toLowerCase()}`}>
                <span className="mono">{result.epc}</span>
                <span>{result.message}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {open && executor ? <FixedReaderPanel dispatchId={id} onChanged={detail.reload} /> : null}

      {data.incidents.length > 0 ? (
        <section className="card">
          <h2 className="subtitle">Incidencias</h2>
          <ul className="incident-list">
            {data.incidents.map((incident) => (
              <li key={incident.id} className={incident.status === 'OPEN' ? 'incident-open' : 'incident-resolved'}>
                <div>
                  <strong>{incident.message}</strong>
                  <small>
                    {incident.epc} · {incident.occurrences} lectura(s) · {incident.source === 'HANDHELD' ? 'pistola' : incident.source === 'SIMULATOR' ? 'simulador' : 'lector fijo'} · {formatDateTime(incident.lastSeenAt)}
                    {incident.resolution ? ` · resuelta: ${incident.resolution}` : ''}
                  </small>
                </div>
                {incident.status === 'OPEN' && (executor || user?.role === 'ADMIN') ? (
                  <span className="incident-resolve">
                    <input
                      aria-label={`Resolución de la incidencia del chip ${incident.epc}`}
                      placeholder="Cómo se resolvió (p. ej. paquete retirado)"
                      value={resolving[incident.id] ?? ''}
                      onChange={(e) => setResolving({ ...resolving, [incident.id]: e.target.value })}
                    />
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy || !(resolving[incident.id] ?? '').trim()}
                      onClick={() =>
                        void act(() =>
                          request(`/dispatches/${enc(id)}/incidents/${enc(incident.id)}/resolve`, { method: 'POST', body: { resolution: resolving[incident.id].trim() } }),
                        )
                      }
                    >
                      Resolver
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {openIncidents.length > 0 ? <p className="field-hint">El material incompatible no cuenta para el despacho. La salida se confirma cuando no hay incidencias abiertas.</p> : null}
        </section>
      ) : null}

      {open && manager ? (
        <section className="card">
          {manage ? (
            <>
              {manage.kind === 'reassign' ? (
                <Field label="Nuevo responsable">
                  <select value={manage.assigneeId} onChange={(e) => setManage({ ...manage, assigneeId: e.target.value })}>
                    <option value="">Elige…</option>
                    {(assignees.data ?? []).filter((a) => a.id !== data.assignee.id).map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </Field>
              ) : null}
              <Field label="Motivo" hint={manage.kind === 'cancel' ? 'Libera lo preparado; las salidas confirmadas no existen aún en este despacho.' : 'Se avisa al nuevo y al anterior responsable.'}>
                <input value={manage.reason} maxLength={300} onChange={(e) => setManage({ ...manage, reason: e.target.value })} />
              </Field>
              <div className="actions">
                <button
                  type="button"
                  className={manage.kind === 'cancel' ? 'button button-danger' : 'button'}
                  disabled={busy || !manage.reason.trim() || (manage.kind === 'reassign' && !manage.assigneeId)}
                  onClick={() =>
                    void act(async () => {
                      await request(`/dispatches/${enc(id)}/${manage.kind}`, {
                        method: 'POST',
                        body: manage.kind === 'cancel' ? { reason: manage.reason.trim() } : { assigneeId: manage.assigneeId, reason: manage.reason.trim() },
                      })
                      setManage(null)
                      onChanged?.()
                    })
                  }
                >
                  {manage.kind === 'cancel' ? 'Cancelar despacho' : 'Reasignar'}
                </button>
                <button type="button" className="text-button" onClick={() => setManage(null)}>Volver</button>
              </div>
            </>
          ) : (
            <div className="actions">
              <button type="button" className="button button-secondary" onClick={() => setManage({ kind: 'reassign', reason: '', assigneeId: '' })}>Reasignar responsable</button>
              <button type="button" className="text-button danger" onClick={() => setManage({ kind: 'cancel', reason: '', assigneeId: '' })}>Cancelar despacho…</button>
            </div>
          )}
        </section>
      ) : null}

      {error ? <Notice kind={uncertain ? 'warning' : 'error'}>{error}</Notice> : null}
      {open && executor ? (
        <section className="card">
          {confirming ? (
            <div className="confirm" role="alertdialog" aria-label="Confirmar salida">
              <div>
                ¿Salieron físicamente los <strong>{data.progress.prepared}</strong> perfiles preparados? Se descontarán del inventario, se consumirán las reservas y se completará la tarea.
              </div>
              <div className="actions">
                <button type="button" className="button button-danger" disabled={busy} onClick={() => void confirm()}>
                  {busy ? 'Registrando…' : 'Confirmar salida física'}
                </button>
                <button type="button" className="button button-secondary" disabled={busy || uncertain} onClick={() => setConfirming(false)}>Volver</button>
              </div>
            </div>
          ) : (
            <button type="button" className="button" disabled={!data.progress.readyToConfirm || busy} onClick={() => setConfirming(true)}>
              Revisar y confirmar salida
            </button>
          )}
          {!data.progress.readyToConfirm ? <p className="field-hint">Disponible cuando todo lo autorizado esté preparado y no haya incidencias abiertas.</p> : null}
        </section>
      ) : null}
    </>
  )
}
