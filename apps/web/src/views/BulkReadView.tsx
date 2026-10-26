import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from 'react'
import { ApiError, describeError } from '../api/client'
import type { Bundle } from '../api/types'
import { IconScan } from '../components/icons'
import { Empty, Field, Kpi, Notice, PageHeader } from '../components/ui'
import type { TagRead } from '../lib/chafon'
import { bundlePlace, finishLabel, referenceLabel } from '../lib/format'
import { useChafonReader, type ReaderPower } from '../lib/useChafonReader'
import { useUnsavedWork } from '../pwa/workGuard'
import { canOperate, useSession } from '../session/session-context'
import type { Navigate } from './navigation'

const EPC_PATTERN = /^[A-Z0-9]{1,128}$/
// Chips sent per lookup request (API limit: 200).
const LOOKUP_BATCH = 200
// Unique chips kept per session, to bound memory and requests.
const MAX_CHIPS = 3000
const FLUSH_MS = 250
const RETRY_MS = 3000

type ChipState = 'pending' | 'found' | 'missing' | 'invalid' | 'error'

export interface BulkChip {
  epc: string
  reads: number
  rssi: number | null
  state: ChipState
  bundle?: Bundle
}

// Read chips in read order (Map insertion order). Kept by the workspace so
// opening a bundle and coming back does not lose the session; cleared on
// logout.
export type BulkChips = Map<string, BulkChip>
type Chip = BulkChip

interface LookupResult {
  bundles: Bundle[]
  missing: string[]
}

// Quick choices as a share of the model's maximum power (H103: 12 / 21 / 33
// dBm). Less power, shorter range: fewer neighbouring bundles read by mistake.
function rangePresets(min: number, max: number) {
  return [
    { label: 'Corta', hint: 'Solo lo cercano', value: Math.max(min, Math.round(max * 0.35)) },
    { label: 'Media', hint: 'Uso general', value: Math.max(min, Math.round(max * 0.65)) },
    { label: 'Larga', hint: 'Máximo alcance', value: max },
  ]
}

// Read range of the handheld (its RF power). Changed with the reader idle;
// the value is written to the reader, keeping its other settings.
function ReadRange({
  power,
  locked,
  onChange,
  onRetry,
}: {
  power: ReaderPower
  locked: boolean
  onChange: (value: number) => void
  onRetry: () => void
}) {
  const [draft, setDraft] = useState<number | null>(null)

  if (power.value === null) {
    return (
      <div className="read-range">
        <strong className="read-range-title">Distancia de lectura</strong>
        {power.error ? (
          <small className="read-range-error">
            {power.error}{' '}
            <button type="button" className="link" onClick={onRetry}>Reintentar</button>
          </small>
        ) : (
          <small className="read-range-note">Consultando la pistola…</small>
        )}
      </div>
    )
  }

  const current = power.value
  const value = draft ?? current
  const apply = (next: number) => {
    setDraft(null)
    if (next !== current) onChange(next)
  }

  return (
    <fieldset className="read-range" disabled={locked || power.busy}>
      <legend className="read-range-title">Distancia de lectura</legend>
      <div className="read-range-options">
        {rangePresets(power.min, power.max).map((preset) => (
          <button
            key={preset.label}
            type="button"
            className={`range-option${draft === null && current === preset.value ? ' selected' : ''}`}
            aria-pressed={draft === null && current === preset.value}
            onClick={() => apply(preset.value)}
          >
            <strong>{preset.label}</strong>
            <small>{preset.hint}</small>
          </button>
        ))}
      </div>
      <label className="read-range-fine">
        <span>Ajuste fino</span>
        <input
          type="range"
          min={power.min}
          max={power.max}
          step={1}
          value={value}
          aria-valuetext={`${value} dBm`}
          onChange={(e) => setDraft(Number(e.target.value))}
        />
        <output>{value} dBm</output>
      </label>
      {draft !== null && draft !== current ? (
        <div className="read-range-apply">
          <button type="button" className="button button-secondary" onClick={() => apply(draft)}>
            Aplicar {draft} dBm
          </button>
          <button type="button" className="text-button" onClick={() => setDraft(null)}>Cancelar</button>
        </div>
      ) : null}
      {power.error ? <small className="read-range-error">{power.error}</small> : null}
      <small className="read-range-note">
        {locked
          ? 'Detén la lectura para cambiar la distancia.'
          : power.busy
            ? 'Guardando en la pistola…'
            : power.saved
              ? `Distancia guardada en la pistola: ${current} dBm.`
              : `Potencia actual: ${current} de ${power.max} dBm${power.model ? ` (${power.model})` : ''}. Menos distancia evita leer paquetes vecinos.`}
      </small>
    </fieldset>
  )
}

// Bulk RFID reading: many chips at once, each shown with its reference.
// Read-only: nothing is registered or changed in the inventory.
export function BulkReadView({
  navigate,
  chips,
  setChips,
}: {
  navigate: Navigate
  chips: BulkChips
  setChips: Dispatch<SetStateAction<BulkChips>>
}) {
  const { request, user } = useSession()
  const operator = canOperate(user?.role)
  const [manual, setManual] = useState('')
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'found' | 'missing'>('all')
  const [confirmClear, setConfirmClear] = useState(false)
  const [retryTick, setRetryTick] = useState(0)
  const buffer = useRef<{ epc: string; rssi: number | null }[]>([])
  const flushTimer = useRef<number | null>(null)
  const inFlight = useRef(false)
  const blockedUntil = useRef(0)

  // Reads arrive many times per second (the same chip repeats): they are
  // grouped and applied a few times per second.
  const flush = useCallback(() => {
    flushTimer.current = null
    const reads = buffer.current
    buffer.current = []
    if (reads.length === 0) return
    setChips((previous) => {
      const next = new Map(previous)
      for (const { epc, rssi } of reads) {
        const chip = next.get(epc)
        if (chip) {
          next.set(epc, { ...chip, reads: chip.reads + 1, rssi: rssi ?? chip.rssi })
          continue
        }
        if (next.size >= MAX_CHIPS) continue
        next.set(epc, {
          epc,
          reads: 1,
          rssi,
          state: EPC_PATTERN.test(epc) ? 'pending' : 'invalid',
        })
      }
      return next
    })
  }, [setChips])

  const addRead = useCallback(
    (raw: string, rssi: number | null) => {
      const epc = raw.trim().toUpperCase()
      if (!epc) return
      buffer.current.push({ epc, rssi })
      if (flushTimer.current === null) flushTimer.current = window.setTimeout(flush, FLUSH_MS)
    },
    [flush],
  )

  const onTag = useCallback((tag: TagRead) => addRead(tag.epc, tag.rssi), [addRead])
  const reader = useChafonReader(onTag)
  // An app update (reload) would cut the Bluetooth link: ask first.
  useUnsavedWork(
    reader.reading || reader.trigger
      ? 'Lectura RFID en curso'
      : reader.status === 'connected'
        ? 'Pistola RFID conectada por Bluetooth'
        : null,
  )

  useEffect(
    () => () => {
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current)
    },
    [],
  )

  // Looks up new chips in batches, one request at a time.
  const pending = useMemo(() => [...chips.values()].filter((chip) => chip.state === 'pending').map((chip) => chip.epc), [chips])
  useEffect(() => {
    // After a temporary failure, new reads wait for the retry instead of
    // sending a request per flush.
    if (pending.length === 0 || inFlight.current || Date.now() < blockedUntil.current) return
    const batch = pending.slice(0, LOOKUP_BATCH)
    inFlight.current = true
    let retry: number | null = null
    void (async () => {
      try {
        const { data } = await request<LookupResult>('/inventory/bundles/lookup', { method: 'POST', body: { epcs: batch } })
        const found = new Map(data.bundles.map((bundle) => [bundle.epc, bundle]))
        setLookupError(null)
        setChips((previous) => {
          const next = new Map(previous)
          for (const epc of batch) {
            const chip = next.get(epc)
            if (!chip) continue
            const bundle = found.get(epc)
            next.set(epc, bundle ? { ...chip, state: 'found', bundle } : { ...chip, state: 'missing', bundle: undefined })
          }
          return next
        })
      } catch (err) {
        const temporary =
          err instanceof ApiError &&
          (err.status === 0 || err.status === 429 || (err.data as { retryable?: boolean } | null)?.retryable === true)
        setLookupError(
          temporary
            ? `${describeError(err)} Las lecturas se conservan y se consultarán de nuevo en unos segundos.`
            : describeError(err),
        )
        if (temporary) {
          blockedUntil.current = Date.now() + RETRY_MS
          retry = window.setTimeout(() => setRetryTick((tick) => tick + 1), RETRY_MS)
        } else {
          setChips((previous) => {
            const next = new Map(previous)
            for (const epc of batch) {
              const chip = next.get(epc)
              if (chip?.state === 'pending') next.set(epc, { ...chip, state: 'error' })
            }
            return next
          })
        }
      } finally {
        inFlight.current = false
        // Chips read meanwhile trigger the next batch.
        if (retry === null) setRetryTick((tick) => tick + 1)
      }
    })()
  }, [pending, request, retryTick, setChips])

  const retryErrors = () => {
    setLookupError(null)
    setChips((previous) => {
      const next = new Map(previous)
      for (const chip of next.values()) if (chip.state === 'error') next.set(chip.epc, { ...chip, state: 'pending' })
      return next
    })
  }

  const submitManual = (event: FormEvent) => {
    event.preventDefault()
    // HID readers type each chip followed by Enter; a pasted list also works.
    for (const code of manual.split(/[\s,;]+/)) addRead(code, null)
    setManual('')
  }

  const clear = () => {
    buffer.current = []
    setChips(new Map())
    setLookupError(null)
    setConfirmClear(false)
  }

  // Newest read first.
  const list = useMemo(() => [...chips.values()].reverse(), [chips])
  const full = chips.size >= MAX_CHIPS
  const found = list.filter((chip) => chip.state === 'found')
  const missing = list.filter((chip) => chip.state === 'missing' || chip.state === 'invalid')
  const profiles = found.reduce((sum, chip) => sum + (chip.bundle?.quantity ?? 0), 0)
  const visible = filter === 'found' ? found : filter === 'missing' ? missing : list

  // Grouped by reference + finish: the quick answer to "what did I read?".
  const groups = useMemo(() => {
    const map = new Map<string, { reference: string; finish: string; bundles: number; profiles: number }>()
    for (const chip of found) {
      const bundle = chip.bundle!
      const key = `${bundle.reference.id}|${bundle.finish.id}`
      const group = map.get(key) ?? { reference: referenceLabel(bundle.reference), finish: finishLabel(bundle.finish), bundles: 0, profiles: 0 }
      group.bundles += 1
      group.profiles += bundle.quantity
      map.set(key, group)
    }
    return [...map.values()].sort((a, b) => b.bundles - a.bundles)
  }, [found])

  const connected = reader.status === 'connected'

  return (
    <>
      <PageHeader
        eyebrow="Inventario · RFID"
        title="Lectura masiva"
        description="Lee muchos paquetes a la vez con la pistola Chafon y ve la referencia de cada chip. Solo consulta: no registra ni cambia el inventario."
      />

      <div className="bulk-layout">
        <section className="card bulk-reader" aria-label="Lector">
          <div className="bulk-reader-head">
            <span className={`reader-dot ${connected ? (reader.reading || reader.trigger ? 'reading' : 'on') : ''}`} aria-hidden="true" />
            <div>
              <strong>
                {reader.status === 'unsupported'
                  ? 'Bluetooth no disponible en este navegador'
                  : connected
                    ? reader.deviceName
                    : reader.status === 'connecting'
                      ? 'Conectando…'
                      : 'Lector desconectado'}
              </strong>
              <small>
                {connected
                  ? reader.reading || reader.trigger
                    ? 'Leyendo chips…'
                    : 'Listo: aprieta el gatillo o pulsa «Iniciar lectura».'
                  : reader.status === 'unsupported'
                    ? 'Usa Chrome en Android o en computador (con HTTPS), o el modo teclado.'
                    : 'Pistola Chafon H100 / H102 / H103 en modo transparente.'}
              </small>
            </div>
          </div>

          {reader.error ? <Notice kind="error">{reader.error}</Notice> : null}

          {reader.status !== 'unsupported' ? (
            <div className="bulk-reader-actions">
              {connected ? (
                <>
                  {reader.reading ? (
                    <button type="button" className="button bulk-main" onClick={() => void reader.stop()}>
                      Detener lectura
                    </button>
                  ) : (
                    <button type="button" className="button bulk-main" onClick={() => void reader.start()}>
                      Iniciar lectura
                    </button>
                  )}
                  <button type="button" className="button button-secondary" onClick={() => void reader.disconnect()}>
                    Desconectar
                  </button>
                </>
              ) : reader.canReconnect ? (
                <>
                  <button
                    type="button"
                    className="button bulk-main"
                    disabled={reader.status === 'connecting'}
                    onClick={() => void reader.reconnect()}
                  >
                    {reader.status === 'connecting' ? 'Conectando…' : 'Reconectar'}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={reader.status === 'connecting'}
                    onClick={() => void reader.connect()}
                  >
                    Elegir otro lector
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button bulk-main"
                  disabled={reader.status === 'connecting'}
                  onClick={() => void reader.connect()}
                >
                  {reader.status === 'connecting' ? 'Conectando…' : 'Conectar lector Bluetooth'}
                </button>
              )}
            </div>
          ) : null}

          {connected ? (
            <ReadRange
              power={reader.power}
              locked={reader.reading || reader.trigger}
              onChange={(value) => void reader.setPower(value)}
              onRetry={() => void reader.reloadPower()}
            />
          ) : null}

          {/* Collapsed when Bluetooth is available, to keep the results close
              on phones; always open otherwise (it is the only way to read). */}
          <details className="bulk-manual" open={reader.status === 'unsupported' || undefined}>
            <summary>Modo teclado o código manual</summary>
          <form onSubmit={submitManual}>
            <Field
              label="Código del chip"
              wide
              hint="Si la pistola está en modo HID (teclado), deja el cursor aquí: cada chip leído se agrega solo. También puedes pegar varios códigos."
            >
              <span className="input-wrap">
                <IconScan />
                <input
                  className="mono"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="E2003412…"
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  onPaste={(e) => {
                    // A one-line field would glue a pasted list together
                    // (line breaks are dropped): split it here instead.
                    const text = e.clipboardData.getData('text')
                    if (!/[\s,;]/.test(text.trim())) return
                    e.preventDefault()
                    for (const code of text.split(/[\s,;]+/)) addRead(code, null)
                  }}
                />
              </span>
            </Field>
          </form>
          </details>
        </section>

        <div className="kpis bulk-kpis">
          <Kpi label="Chips leídos" value={list.length} hint={pending.length > 0 ? `${pending.length} consultando…` : 'Sin repetir'} dark />
          <Kpi label="Registrados" value={found.length} hint={`${profiles} perfiles`} />
          <Kpi label="No registrados" value={missing.length} hint="Chips sin paquete" />
        </div>
      </div>

      {full ? (
        <Notice kind="warning">
          Se alcanzó el máximo de {MAX_CHIPS} chips en pantalla; las lecturas nuevas no se agregan. Limpia la lista para
          seguir.
        </Notice>
      ) : null}
      {lookupError ? (
        <Notice kind="error">
          {lookupError}{' '}
          {list.some((chip) => chip.state === 'error') ? (
            <button type="button" className="link" onClick={retryErrors}>Reintentar</button>
          ) : null}
        </Notice>
      ) : null}

      {list.length === 0 ? (
        <Empty title="Aún no hay lecturas">
          Conecta la pistola y aprieta el gatillo cerca de los paquetes, o usa el modo teclado.
        </Empty>
      ) : (
        <>
          {groups.length > 0 ? (
            <section className="bulk-groups" aria-label="Resumen por referencia">
              <h2 className="subtitle">Por referencia</h2>
              <ul>
                {groups.map((group) => (
                  <li key={`${group.reference}|${group.finish}`}>
                    <span>
                      <strong>{group.reference}</strong>
                      <small>{group.finish}</small>
                    </span>
                    <span className="bulk-group-count">
                      <strong>{group.bundles}</strong> {group.bundles === 1 ? 'paquete' : 'paquetes'}
                      <small>{group.profiles} perfiles</small>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="tabs bulk-filter" role="tablist" aria-label="Filtrar lecturas">
            {(
              [
                ['all', 'Todos', list.length],
                ['found', 'Registrados', found.length],
                ['missing', 'No registrados', missing.length],
              ] as const
            ).map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                className={filter === value ? 'tab active' : 'tab'}
                onClick={() => setFilter(value)}
              >
                {label}
                <span className="tab-count">{count}</span>
              </button>
            ))}
            <span className="bulk-clear">
              {confirmClear ? (
                <span className="row-confirm">
                  ¿Borrar las {list.length} lecturas?
                  <button type="button" className="text-button danger" onClick={clear}>Sí, limpiar</button>
                  <button type="button" className="text-button" onClick={() => setConfirmClear(false)}>Cancelar</button>
                </span>
              ) : (
                <button type="button" className="text-button" onClick={() => setConfirmClear(true)}>
                  Limpiar lista
                </button>
              )}
            </span>
          </div>

          {/* One compact line per chip (phones read dozens at a time): chip
              and reference first; finish, location and reads as detail. */}
          <ul className="bulk-list">
            {visible.map((chip) => (
              <li key={chip.epc} className={chip.bundle ? undefined : 'unregistered'}>
                <div className="bulk-item-main">
                  {chip.bundle ? (
                    <button type="button" className="epc-link" onClick={() => navigate({ name: 'bundle', id: chip.bundle!.id })}>
                      {chip.epc}
                    </button>
                  ) : (
                    <span className="mono bulk-epc">{chip.epc}</span>
                  )}
                  {chip.bundle ? (
                    <>
                      <span className="bulk-ref">
                        <strong>{chip.bundle.reference.code}</strong>
                        {chip.bundle.reference.description ? ` · ${chip.bundle.reference.description}` : ''}
                      </span>
                      <small>
                        {finishLabel(chip.bundle.finish)} · {bundlePlace(chip.bundle)}
                      </small>
                    </>
                  ) : (
                    <ChipStatus chip={chip} operator={operator} onRegister={() => navigate({ name: 'register', epc: chip.epc })} />
                  )}
                </div>
                <div className="bulk-item-side">
                  {chip.bundle ? (
                    <span className="bulk-qty">
                      <strong>{chip.bundle.quantity}</strong> perf.
                    </span>
                  ) : null}
                  <small title="Veces que el lector vio este chip">
                    {chip.reads}× {chip.rssi !== null ? `· ${chip.rssi} dBm` : ''}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

function ChipStatus({ chip, operator, onRegister }: { chip: Chip; operator: boolean; onRegister: () => void }) {
  if (chip.state === 'pending') return <span className="badge badge-muted">Consultando…</span>
  if (chip.state === 'invalid') return <span className="badge badge-warning">Código no válido</span>
  if (chip.state === 'error') return <span className="badge badge-warning">Sin consultar</span>
  return (
    <span className="bulk-missing">
      <span className="badge badge-muted">No registrado</span>
      {operator ? (
        <button type="button" className="text-button" onClick={onRegister}>
          Registrar
        </button>
      ) : null}
    </span>
  )
}
