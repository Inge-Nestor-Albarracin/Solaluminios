import { useRef, useState, type FormEvent } from 'react'
import { ApiError, describeError } from '../api/client'
import { IconScan } from '../components/icons'
import { Empty, Field, Kpi, Notice, PageHeader } from '../components/ui'
import { EXIT_TYPES, basketLabel, units, type Basket, type ExitType, type Voucher, type VoucherKind } from '../lib/accessories'
import { useLoad } from '../lib/useLoad'
import { uuid } from '../lib/uuid'
import { useSession } from '../session/session-context'
import type { Navigate } from './navigation'

interface Line {
  basket: Basket
  quantity: string
}

const todayBogota = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date())

// An entry (purchase put in the baskets, with its support) or an exit without
// a sale. Every basket changes or none does; the administrator is told.
export function AccessoryVoucherFormView({ kind, navigate }: { kind: VoucherKind; navigate: Navigate }) {
  const { request } = useSession()
  const entry = kind === 'ENTRY'
  const baskets = useLoad<{ items: Basket[] }>('/accessories/baskets')
  const [lines, setLines] = useState<Line[]>([])
  const [chip, setChip] = useState('')
  const [reading, setReading] = useState(false)
  const [pick, setPick] = useState('')
  const [supplierName, setSupplierName] = useState('')
  const [documentNumber, setDocumentNumber] = useState('')
  const [arrivalDate, setArrivalDate] = useState(todayBogota())
  const [exitType, setExitType] = useState<ExitType>('INTERNAL_USE')
  const [detail, setDetail] = useState('')
  const [receivedBy, setReceivedBy] = useState('')
  const [notes, setNotes] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const key = useRef<string | null>(null)
  const inFlight = useRef(false)

  // Any change makes it a new voucher (new key); a retry keeps the key.
  const touch = () => {
    key.current = null
    setError(null)
  }

  const add = (basket: Basket) => {
    touch()
    if (lines.some((line) => line.basket.id === basket.id)) {
      setNotice(`${basketLabel(basket)} ya está en la lista: cambia su cantidad.`)
      return
    }
    setNotice(null)
    setLines((current) => [...current, { basket, quantity: '' }])
  }

  const readChip = async (event: FormEvent) => {
    event.preventDefault()
    const value = chip.trim().toUpperCase()
    if (!value || reading) return
    setChip('')
    const known = baskets.data?.items.find((b) => b.epc === value)
    if (known) {
      add(known)
      return
    }
    setReading(true)
    try {
      const { data } = await request<Basket>(`/accessories/baskets/epc/${encodeURIComponent(value)}`)
      add(data)
    } catch (err) {
      setNotice(err instanceof ApiError && err.status === 404 ? `El chip ${value} no es de ninguna canasta registrada.` : describeError(err))
    } finally {
      setReading(false)
    }
  }

  const parsed = lines.map((line) => ({ ...line, n: Number(line.quantity) }))
  const total = parsed.reduce((sum, line) => sum + (Number.isInteger(line.n) && line.n > 0 ? line.n : 0), 0)
  const short = entry ? [] : parsed.filter((line) => Number.isInteger(line.n) && line.n > line.basket.available)
  const blocker =
    lines.length === 0
      ? 'agrega al menos una canasta'
      : parsed.some((line) => !Number.isInteger(line.n) || line.n < 1)
        ? 'escribe la cantidad de cada canasta (entera y mayor que cero)'
        : short.length > 0
          ? `${basketLabel(short[0].basket)} solo tiene ${short[0].basket.available}`
          : entry && !supplierName.trim()
            ? 'escribe el proveedor'
            : entry && !documentNumber.trim()
              ? 'escribe el número de la factura o la remisión'
              : !entry && !detail.trim()
                ? 'describe la salida'
                : null

  const save = async () => {
    if (inFlight.current || blocker) return
    inFlight.current = true
    key.current ??= uuid()
    setBusy(true)
    setError(null)
    try {
      const common = {
        operationKey: key.current,
        lines: parsed.map((line) => ({ basketId: line.basket.id, quantity: line.n })),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }
      const body = entry
        ? { ...common, supplierName: supplierName.trim(), documentNumber: documentNumber.trim(), ...(arrivalDate ? { arrivalDate } : {}) }
        : { ...common, exitType, detail: detail.trim(), ...(receivedBy.trim() ? { receivedBy: receivedBy.trim() } : {}) }
      const { data } = await request<Voucher>(entry ? '/accessories/vouchers/entries' : '/accessories/vouchers/exits', { method: 'POST', body })
      navigate({ name: 'voucher', id: data.id })
    } catch (err) {
      setError(describeError(err))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const available = (baskets.data?.items ?? []).filter((b) => !lines.some((line) => line.basket.id === b.id) && (entry || b.available > 0))

  return (
    <>
      <PageHeader
        eyebrow="Accesorios"
        title={entry ? 'Ingreso de accesorios' : 'Salida sin venta'}
        description={
          entry
            ? 'Lo comprado se echa en su canasta: lee el chip de cada canasta y escribe cuántas unidades le agregas. Al guardar, el administrador recibe un aviso.'
            : 'Para lo que sale sin una venta del sistema: lee el chip de cada canasta y escribe cuántas unidades salen. Al guardar, el administrador recibe un aviso.'
        }
        actions={
          <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'accessories' })}>
            Volver a canastas
          </button>
        }
      />

      <section className="card">
        <div className="form-grid">
          {entry ? (
            <>
              <Field label="Proveedor">
                <input value={supplierName} maxLength={150} onChange={(e) => { setSupplierName(e.target.value); touch() }} />
              </Field>
              <Field label="Factura o remisión">
                <input value={documentNumber} maxLength={60} onChange={(e) => { setDocumentNumber(e.target.value); touch() }} />
              </Field>
              <Field label="Fecha de llegada">
                <input type="date" value={arrivalDate} max={todayBogota()} onChange={(e) => { setArrivalDate(e.target.value); touch() }} />
              </Field>
            </>
          ) : (
            <>
              <Field label="Tipo de salida" hint={EXIT_TYPES.find((t) => t.id === exitType)?.hint}>
                <select value={exitType} onChange={(e) => { setExitType(e.target.value as ExitType); touch() }}>
                  {EXIT_TYPES.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Detalle" hint="Obligatorio: para qué o a quién salió.">
                <input value={detail} maxLength={500} onChange={(e) => { setDetail(e.target.value); touch() }} />
              </Field>
              <Field label="Quién recibe (opcional)">
                <input value={receivedBy} maxLength={150} onChange={(e) => { setReceivedBy(e.target.value); touch() }} />
              </Field>
            </>
          )}
          <Field label="Notas (opcional)">
            <input value={notes} maxLength={500} onChange={(e) => { setNotes(e.target.value); touch() }} />
          </Field>
        </div>
      </section>

      <section className="card">
        <form className="lookup-form" onSubmit={readChip}>
          <Field label="Leer chip de la canasta" hint="Con el campo activo, el lector escribe el código y lo agrega a la lista.">
            <span className="input-wrap">
              <IconScan />
              <input className="mono" autoFocus autoComplete="off" spellCheck={false} value={chip} onChange={(e) => setChip(e.target.value.toUpperCase())} />
            </span>
          </Field>
          <button type="submit" className="button button-secondary" disabled={reading || !chip.trim()}>
            {reading ? 'Buscando…' : 'Agregar'}
          </button>
        </form>
        <div className="lookup-form">
          <Field label="O elige la canasta">
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Elige…</option>
              {available.map((b) => (
                <option key={b.id} value={b.id}>
                  {basketLabel(b)} · {entry ? `hay ${b.quantity}` : `disponibles ${b.available}`}
                </option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            className="button button-secondary"
            disabled={!pick}
            onClick={() => {
              const basket = available.find((b) => b.id === pick)
              if (basket) add(basket)
              setPick('')
            }}
          >
            Agregar
          </button>
        </div>
        {notice ? <Notice kind="info">{notice}</Notice> : null}
        {baskets.error ? <Notice kind="error">{baskets.error}</Notice> : null}
      </section>

      {lines.length === 0 ? <Empty title="Sin canastas">Lee el chip de cada canasta o elígela de la lista.</Empty> : null}
      <ul className="doc-list">
        {parsed.map((line, index) => {
          const after = Number.isInteger(line.n) && line.n > 0 ? (entry ? line.basket.quantity + line.n : line.basket.quantity - line.n) : null
          return (
            <li key={line.basket.id}>
              <div className="doc-row">
                <span className="doc-main">
                  <strong>{basketLabel(line.basket)}</strong>
                  <small>
                    <span className="mono">{line.basket.epc}</span> · hay {units(line.basket.quantity)}
                    {!entry && line.basket.reserved > 0 ? ` (${line.basket.reserved} reservadas)` : ''}
                    {after !== null && after >= 0 ? ` · quedará en ${after.toLocaleString('es-CO')}` : ''}
                  </small>
                </span>
                <span className="doc-side">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    aria-label={`Unidades de ${basketLabel(line.basket)}`}
                    style={{ width: '7rem' }}
                    value={line.quantity}
                    onChange={(e) => {
                      const value = e.target.value
                      touch()
                      setLines((current) => current.map((l, i) => (i === index ? { ...l, quantity: value } : l)))
                    }}
                  />
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      touch()
                      setLines((current) => current.filter((_, i) => i !== index))
                    }}
                  >
                    Quitar
                  </button>
                </span>
              </div>
            </li>
          )
        })}
      </ul>

      {lines.length > 0 ? (
        <div className="kpis">
          <Kpi label="Canastas" value={lines.length} />
          <Kpi label={entry ? 'Unidades que entran' : 'Unidades que salen'} value={total.toLocaleString('es-CO')} dark />
        </div>
      ) : null}

      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="actions">
        <button type="button" className="button" disabled={busy || blocker !== null} onClick={() => void save()}>
          {busy ? 'Guardando…' : entry ? 'Guardar ingreso' : 'Guardar salida'}
        </button>
        {blocker && !busy ? <span className="cell-sub save-blocker">Para guardar: {blocker}</span> : null}
      </div>
    </>
  )
}
