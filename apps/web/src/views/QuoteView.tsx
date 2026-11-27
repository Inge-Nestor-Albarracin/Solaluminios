import { useEffect, useRef, useState } from 'react'
import { ApiError, describeError } from '../api/client'
import { CatalogSelectors } from '../components/CatalogSelectors'
import { CustomerPicker } from '../components/CustomerPicker'
import { DownloadPdfButton } from '../components/DownloadPdfButton'
import { Field, Loading, Notice, PageHeader } from '../components/ui'
import {
  DISCOUNT_REQUEST_STATUS_LABEL,
  ORIGIN_LABEL,
  PAYMENT_METHOD_LABEL,
  PAYMENT_TERMS_HINT,
  ENTITY_PLACEHOLDER,
  ENTITY_QUESTION,
  type TransferEntity,
  PRICING_LABEL,
  SELLER_GLOBAL_DISCOUNT_LIMIT,
  formatMoney,
  formatPercent,
  formatUnitCost,
  paymentLabel,
  totalsParts,
  SALE_TYPE_LABEL,
  hasLabour,
  availableByLocation,
  type AvailabilityGroup,
  type Customer,
  type DiscountRequest,
  type MaterialOrigin,
  type QuoteLine,
  type PaymentMethod,
  type Quote,
  type SaleType,
  type Supplier,
} from '../lib/commerce'
import { EMPTY_CATALOG, type CatalogValue } from '../lib/forms'
import { formatDateTime } from '../lib/format'
import { parseMoney, percentOfCents } from '../lib/numbers'
import { notifyRequestUpdatesChanged } from '../lib/requestUpdates'
import { useLoad } from '../lib/useLoad'
import { uuid } from '../lib/uuid'
import { useUnsavedWork } from '../pwa/workGuard'
import { useSession } from '../session/session-context'
import type { Navigate } from './navigation'

interface LineDraft {
  key: string
  catalog: CatalogValue
  origin: MaterialOrigin
  supplierId: string
  quantity: string
  discountPercent: string
  taxRatePercent: string
  // Manual price (always possible; authorised by an administrator).
  manual: boolean
  manualPrice: string
  priceReason: string
  estimatedCost: string
}

// China preselected for new lines (agreed default), visible and editable.
// IVA preloaded at 19 % and editable.
const newLine = (): LineDraft => ({
  key: uuid(),
  catalog: EMPTY_CATALOG,
  origin: 'CHINA',
  supplierId: '',
  quantity: '',
  discountPercent: '0',
  taxRatePercent: '19',
  manual: false,
  manualPrice: '',
  priceReason: '',
  estimatedCost: '',
})

const decimal = (value: string) => value.trim().replace(',', '.')
// Cents as people type them here: «3453» or «3453,11» (read back by parseMoney).
const typedPesos = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace('.', ','))
const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/
// Manual price: pesos with up to 2 decimals (the API's rule).
const MANUAL_PRICE = /^\d{1,12}(\.\d{1,2})?$/
// Minimum explanation of a manual price (the API's rule).
const PRICE_REASON_MIN = 10
// Line discount a seller gives alone (the API's rule); more needs a manual
// price, which an administrator authorises with its discount.
const SELLER_LINE_DISCOUNT_LIMIT = 3
const MONEY_HINT = 'Escribe el precio en pesos, mayor que cero, p. ej. 12.000 o 12000,50.'
// A labour amount from this value on is confirmed once (typing errors).
const LARGE_SERVICE = 1_000_000
// Labour field: empty (not charged) or pesos with up to 2 decimals.
const serviceValue = (text: string): string | null => {
  if (!text.trim()) return '0'
  const value = parseMoney(text)
  return MANUAL_PRICE.test(value) ? value : null
}

// Authorisation of a draft line's discount above the seller's 3 % on the
// enabled price: who gave it, or (refused) up to how many profiles it was
// given for this material and discount.
type DiscountAuthorisation = { by: string } | { upTo: number } | null

const discountKey = (referenceId: string, finishId: string, origin: string, supplierId: string | null, percent: string) =>
  JSON.stringify([referenceId, finishId, origin, supplierId || null, Number(percent).toFixed(4)])

// Same rule as the API: an administrator's discount (saved by an
// administrator) covers one line with the same material and discount and
// no more profiles, smallest fit first. A discount nobody authorised (a
// manual price not authorised, a rejected request, older data) never counts.
function discountAuthorisations(saved: QuoteLine[], drafts: LineDraft[]): Record<string, DiscountAuthorisation> {
  const pool = new Map<string, { quantity: number; by: string }[]>()
  for (const line of saved) {
    if (line.manualPrice || !line.discountApprovedBy || Number(line.discountPercent) <= SELLER_LINE_DISCOUNT_LIMIT) continue
    const key = discountKey(line.referenceId, line.finishId, line.origin, line.supplierId, line.discountPercent)
    pool.set(key, [...(pool.get(key) ?? []), { quantity: line.quantity, by: line.discountApprovedBy.name }].sort((a, b) => a.quantity - b.quantity))
  }
  const result: Record<string, DiscountAuthorisation> = {}
  for (const line of drafts) {
    const value = decimal(line.discountPercent || '0')
    result[line.key] = null
    if (line.manual || !DECIMAL.test(value) || Number(value) <= SELLER_LINE_DISCOUNT_LIMIT) continue
    const list = pool.get(discountKey(line.catalog.referenceId, line.catalog.finishId, line.origin, line.supplierId, value)) ?? []
    const index = list.findIndex((item) => item.quantity >= Number(line.quantity))
    if (index >= 0) result[line.key] = { by: list.splice(index, 1)[0].by }
    else if (list.length > 0) result[line.key] = { upTo: list[list.length - 1].quantity }
  }
  return result
}

// Why the line discount cannot be saved (null when it can).
function lineDiscountError(line: LineDraft, isAdmin: boolean, authorisation: DiscountAuthorisation): string | null {
  const value = decimal(line.discountPercent || '0')
  if (!DECIMAL.test(value) || Number(value) > 100) return 'Escribe un porcentaje entre 0 y 100, p. ej. 2 o 2,5.'
  if (!isAdmin && !line.manual && Number(value) > SELLER_LINE_DISCOUNT_LIMIT && !(authorisation && 'by' in authorisation)) {
    if (authorisation && 'upTo' in authorisation) {
      return `Un administrador autorizó este descuento para hasta ${authorisation.upTo} perfiles de este material. Para más perfiles deja máximo ${SELLER_LINE_DISCOUNT_LIMIT} %, usa precio manual (lo autoriza un administrador) o pide un descuento global.`
    }
    return `Puedes dar hasta ${SELLER_LINE_DISCOUNT_LIMIT} % por renglón. Para más, usa precio manual (lo autoriza un administrador) o pide un descuento global.`
  }
  return null
}

// Price used by the line: the manual one or the enabled one.
function linePrice(line: LineDraft, enabled: string | null): string | null {
  if (!line.manual) return enabled
  const price = parseMoney(line.manualPrice)
  return MANUAL_PRICE.test(price) && Number(price) > 0 ? price : null
}

// What an administrator authorised on a manual line (same fields as the
// API): if any changes, the authorisation is lost.
function manualKey(line: { referenceId: string; finishId: string; origin: string; supplierId: string | null; quantity: number; unitPrice: string; discountPercent: string; priceReason: string; estimatedCost: string }) {
  return JSON.stringify([
    line.referenceId,
    line.finishId,
    line.origin,
    line.supplierId || null,
    line.quantity,
    Number(line.unitPrice).toFixed(2),
    Number(line.discountPercent || '0').toFixed(4),
    line.priceReason.trim(),
    line.estimatedCost ? Number(line.estimatedCost).toFixed(6) : '',
  ])
}
const draftKey = (line: LineDraft) =>
  manualKey({
    referenceId: line.catalog.referenceId,
    finishId: line.catalog.finishId,
    origin: line.origin,
    supplierId: line.supplierId,
    quantity: Number(line.quantity),
    unitPrice: parseMoney(line.manualPrice),
    discountPercent: decimal(line.discountPercent || '0'),
    priceReason: line.priceReason,
    estimatedCost: parseMoney(line.estimatedCost),
  })
const savedKey = (line: QuoteLine) =>
  manualKey({
    referenceId: line.referenceId,
    finishId: line.finishId,
    origin: line.origin,
    supplierId: line.supplierId,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    discountPercent: line.discountPercent,
    priceReason: line.priceReason ?? '',
    estimatedCost: line.estimatedUnitCost ?? '',
  })

// Margin over the estimated cost, e.g. «25 %».
function marginText(price: string | null, cost: string | null) {
  if (!price || !cost || !(Number(price) > 0) || !(Number(cost) > 0)) return null
  return formatPercent(Math.round(((Number(price) - Number(cost)) / Number(price)) * 10000) / 100)
}

interface Amounts {
  subtotal: number
  discount: number
  tax: number
  total: number
  // IVA rate of the line, to recompute its VAT after the global discount.
  taxRate: number
}

// Preview with the server's rule (subtotal = qty × price; discount on the
// subtotal; IVA on the discounted base; cents rounded half up). The server
// recomputes on save; this only keeps the screen in step while typing.
function lineAmounts(line: LineDraft, unitPrice: string | null): Amounts | null {
  const quantity = Number(line.quantity)
  const discount = decimal(line.discountPercent || '0')
  const tax = decimal(line.taxRatePercent)
  if (!unitPrice || !Number.isInteger(quantity) || quantity < 1 || !DECIMAL.test(discount) || !DECIMAL.test(tax)) return null
  const cents = Math.round(Number(unitPrice) * 100) * quantity
  const discountCents = percentOfCents(cents, discount)
  const taxCents = percentOfCents(cents - discountCents, tax)
  return { subtotal: cents / 100, discount: discountCents / 100, tax: taxCents / 100, total: (cents - discountCents + taxCents) / 100, taxRate: Number(tax) }
}

// 0, or 0.1–100 with up to 2 decimals (the API's rule).
const GLOBAL_DISCOUNT = /^\d{1,3}(\.\d{1,2})?$/
function validGlobalDiscount(value: string) {
  if (!GLOBAL_DISCOUNT.test(value)) return false
  const number = Number(value)
  return number === 0 || (number >= 0.1 && number <= 100)
}

// Document preview with the global discount, as the server applies it: base
// (after line discounts) × % rounded to cents, split over the lines by base
// (largest remainders), and the IVA of each line on what is left.
function documentPreview(lines: Amounts[], globalPercent: number) {
  const bases = lines.map((line) => Math.round((line.subtotal - line.discount) * 100))
  const baseTotal = bases.reduce((total, base) => total + base, 0)
  const globalCents = percentOfCents(baseTotal, globalPercent)
  const shares = bases.map(() => 0)
  if (baseTotal > 0 && globalCents > 0) {
    // Exact proportions (integers): the remainders decide the extra cents.
    const raw = bases.map((base) => BigInt(globalCents) * BigInt(base))
    const total = BigInt(baseTotal)
    raw.forEach((value, index) => (shares[index] = Number(value / total)))
    let remaining = globalCents - shares.reduce((sum, share) => sum + share, 0)
    const order = raw
      .map((value, index) => ({ index, remainder: value % total }))
      .sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index))
    for (const { index } of order) {
      if (remaining <= 0) break
      shares[index] += 1
      remaining -= 1
    }
  }
  const taxCents = lines.reduce((total, line, index) => total + percentOfCents(bases[index] - shares[index], line.taxRate), 0)
  const cents = (value: number) => (value / 100).toFixed(2)
  return {
    subtotal: cents(lines.reduce((total, line) => total + Math.round(line.subtotal * 100), 0)),
    discountTotal: cents(lines.reduce((total, line) => total + Math.round(line.discount * 100), 0)),
    globalDiscountPercent: String(globalPercent),
    globalDiscountAmount: cents(globalCents),
    taxTotal: cents(taxCents),
    total: cents(baseTotal - globalCents + taxCents),
  }
}

const REQUEST_PATH = { GLOBAL_DISCOUNT: 'discount-requests', MANUAL_PRICE: 'price-requests' } as const

// Open or answered requests of the quote to an administrator: global discount
// above the seller's limit and manual prices. The administrator the seller
// chose answers here (and may correct manual prices); the seller (or any
// administrator) can withdraw an open one.
function DiscountRequests({ quote, onChanged }: { quote: Quote; onChanged: () => void }) {
  const pending = quote.discountRequests.filter((r) => r.status === 'PENDING')
  const answered = quote.discountRequests.filter((r) => r.status !== 'PENDING').slice(0, 5)
  if (pending.length === 0 && answered.length === 0) return null
  return (
    <section className={`card discount-requests${pending.length > 0 ? ' has-pending' : ''}`}>
      {pending.map((r) =>
        r.kind === 'MANUAL_PRICE' ? <ManualPriceRequest key={r.id} quote={quote} pending={r} onChanged={onChanged} /> : <GlobalDiscountRequest key={r.id} quote={quote} pending={r} onChanged={onChanged} />,
      )}
      {answered.length > 0 ? (
        <>
          <h2 className="subtitle">Historial de solicitudes</h2>
          <ul className="discount-history">
            {answered.map((r) => (
              <li key={r.id}>
                {r.kind === 'MANUAL_PRICE' ? 'Precio manual' : `Descuento global ${formatPercent(r.requestedPercent ?? 0)}`} · <strong>{DISCOUNT_REQUEST_STATUS_LABEL[r.status]}</strong>
                {r.status === 'CANCELLED' ? (r.replacedById ? ' (reemplazada por otra)' : '') : ` por ${r.approver.name}`}
                {r.resolvedAt ? ` · ${formatDateTime(r.resolvedAt)}` : ''}
                {r.kind === 'MANUAL_PRICE' && r.status === 'APPROVED'
                  ? (r.details?.lines ?? [])
                      .filter((item) => item.approvedUnitPrice && Number(item.approvedUnitPrice) !== Number(item.proposedUnitPrice))
                      .map((item) => ` · renglón ${item.lineNo}: ${formatMoney(item.proposedUnitPrice)} → ${formatMoney(item.approvedUnitPrice)}`)
                      .join('')
                  : ''}
                {r.resolution ? ` · «${r.resolution}»` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}

// Shared actions of an open request: answer (chosen administrator) or withdraw.
function useRequestActions(quote: Quote, target: DiscountRequest, onChanged: () => void) {
  const { request } = useSession()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = async (action: 'approve' | 'reject' | 'cancel', body: object = {}) => {
    setBusy(true)
    setError(null)
    try {
      await request(`/quotes/${encodeURIComponent(quote.id)}/${REQUEST_PATH[target.kind]}/${encodeURIComponent(target.id)}/${action}`, { method: 'POST', body })
      onChanged()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, act }
}

function ManualPriceRequest({ quote, pending, onChanged }: { quote: Quote; pending: DiscountRequest; onChanged: () => void }) {
  const { user } = useSession()
  const { busy, error, act } = useRequestActions(quote, pending, onChanged)
  const items = pending.details?.lines ?? []
  // Prices the administrator approves (prefilled with the proposed ones).
  const [prices, setPrices] = useState<Record<number, string>>(() => Object.fromEntries(items.map((item) => [item.lineNo, String(Number(item.proposedUnitPrice))])))
  const [rejecting, setRejecting] = useState<string | null>(null)
  const approver = user?.id === pending.approver.id
  const validPrice = (lineNo: number) => MANUAL_PRICE.test(parseMoney(prices[lineNo] ?? '')) && Number(parseMoney(prices[lineNo] ?? '')) > 0
  const valid = items.every((item) => validPrice(item.lineNo))
  const approve = () =>
    void act('approve', {
      lines: items
        .filter((item) => Number(parseMoney(prices[item.lineNo])) !== Number(item.proposedUnitPrice))
        .map((item) => ({ lineNo: item.lineNo, unitPrice: parseMoney(prices[item.lineNo]) })),
    })

  return (
    <div className="discount-request manual-request">
      <p className="manual-request-banner">PRECIO MANUAL EN SOLICITUD · pendiente de autorización de {pending.approver.name}</p>
      <p>
        Pedida por <strong>{pending.requestedBy.name}</strong> · {formatDateTime(pending.createdAt)}
      </p>
      <p className="cell-sub">
        Mientras tanto la cotización no se convierte en orden ni se descarga en PDF. Si se cambia un precio manual o se envía otra solicitud, esta se cancela y
        se pierde su avance.
      </p>
      {pending.reason ? <p className="cell-sub">Nota: {pending.reason}</p> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th><th>Material</th><th className="num">Perfiles</th><th className="num">Propuesto</th><th className="num">Habilitado</th><th className="num">Costo est.</th><th className="num">Margen</th><th>Justificación</th>
              {approver ? <th className="num">Precio aprobado</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.lineNo}>
                <td data-label="#">{item.lineNo}</td>
                <td data-label="Material">{item.referenceCode} · {item.finishDescription ?? item.finishCode}</td>
                <td className="num" data-label="Perfiles">{item.quantity}</td>
                <td className="num" data-label="Propuesto">{formatMoney(item.proposedUnitPrice)}</td>
                <td className="num" data-label="Habilitado">{item.enabledUnitPrice ? formatMoney(item.enabledUnitPrice) : 'Sin precio'}</td>
                <td className="num" data-label="Costo est.">{item.estimatedUnitCost ? formatUnitCost(item.estimatedUnitCost) : '—'}</td>
                <td className="num" data-label="Margen">{marginText(approver ? parseMoney(prices[item.lineNo] ?? '') : item.proposedUnitPrice, item.estimatedUnitCost) ?? '—'}</td>
                <td data-label="Justificación">{item.priceReason}</td>
                {approver ? (
                  <td className="num" data-label="Precio aprobado">
                    <input
                      inputMode="decimal"
                      aria-label={`Precio aprobado del renglón ${item.lineNo}`}
                      value={prices[item.lineNo] ?? ''}
                      onChange={(e) => setPrices({ ...prices, [item.lineNo]: e.target.value })}
                    />
                    {validPrice(item.lineNo) ? null : <span className="field-error">{MONEY_HINT}</span>}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {approver ? (
        rejecting !== null ? (
          <div className="form-grid">
            <Field label="Motivo del rechazo (opcional)">
              <input value={rejecting} maxLength={500} onChange={(e) => setRejecting(e.target.value)} />
            </Field>
            <div className="actions">
              <button type="button" className="button button-danger" disabled={busy} onClick={() => void act('reject', rejecting.trim() ? { resolution: rejecting.trim() } : {})}>
                Rechazar solicitud
              </button>
              <button type="button" className="text-button" disabled={busy} onClick={() => setRejecting(null)}>Volver</button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button type="button" className="button" disabled={busy || !valid} onClick={approve}>
              Aprobar precios
            </button>
            <button type="button" className="button button-secondary" disabled={busy} onClick={() => setRejecting('')}>Rechazar</button>
            <span className="cell-sub">Puedes corregir el precio antes de aprobar; queda registrado.</span>
          </div>
        )
      ) : (
        <div className="actions">
          <span className="cell-sub">Solo {pending.approver.name} puede aprobarla, corregirla o rechazarla.</span>
          <button type="button" className="text-button danger" disabled={busy} onClick={() => void act('cancel')}>Cancelar solicitud</button>
        </div>
      )}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </div>
  )
}

function GlobalDiscountRequest({ quote, pending, onChanged }: { quote: Quote; pending: DiscountRequest; onChanged: () => void }) {
  const { user } = useSession()
  const { busy, error, act } = useRequestActions(quote, pending, onChanged)
  const [rejecting, setRejecting] = useState<string | null>(null)
  const percent = pending.requestedPercent ?? '0'
  return (
    <>
      <h2 className="subtitle">Descuento global por autorizar</h2>
      {pending ? (
        <div className="discount-request">
          <p>
            <strong>{pending.requestedBy.name}</strong> pidió a <strong>{pending.approver.name}</strong> un descuento global de{' '}
            <strong className="discount-percent">{formatPercent(percent)}</strong> · {formatDateTime(pending.createdAt)}
          </p>
          {pending.reason ? <p className="cell-sub">Motivo: {pending.reason}</p> : null}
          {pending.projected ? (
            <p>
              Si se aprueba: descuento global −{formatMoney(pending.projected.globalDiscountAmount)} · IVA {formatMoney(pending.projected.taxTotal)} ·{' '}
              <strong>Total {formatMoney(pending.projected.total)}</strong> (hoy {formatMoney(quote.total)})
            </p>
          ) : null}
          {user?.id === pending.approver.id ? (
            rejecting !== null ? (
              <div className="form-grid">
                <Field label="Motivo del rechazo (opcional)">
                  <input value={rejecting} maxLength={500} onChange={(e) => setRejecting(e.target.value)} />
                </Field>
                <div className="actions">
                  <button type="button" className="button button-danger" disabled={busy} onClick={() => void act('reject', rejecting.trim() ? { resolution: rejecting.trim() } : {})}>
                    Rechazar solicitud
                  </button>
                  <button type="button" className="text-button" disabled={busy} onClick={() => setRejecting(null)}>Volver</button>
                </div>
              </div>
            ) : (
              <div className="actions">
                <button type="button" className="button" disabled={busy} onClick={() => void act('approve')}>
                  Aprobar {formatPercent(percent)}
                </button>
                <button type="button" className="button button-secondary" disabled={busy} onClick={() => setRejecting('')}>Rechazar</button>
              </div>
            )
          ) : (
            <div className="actions">
              <span className="cell-sub">Solo {pending.approver.name} puede aprobarla o rechazarla. Mientras tanto la cotización no se convierte en orden.</span>
              <button type="button" className="text-button danger" disabled={busy} onClick={() => void act('cancel')}>Cancelar solicitud</button>
            </div>
          )}
        </div>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </>
  )
}

function LineEditor({
  line,
  index,
  suppliers,
  unitPrice,
  enabledPrice,
  authorisedBy,
  discountAuthorisation,
  myLocation,
  onChange,
  onPrice,
  onRemove,
}: {
  line: LineDraft
  index: number
  suppliers: Supplier[]
  // The seller's location (where an order is normally reserved), if any.
  myLocation: { id: string; name: string } | null
  // Price used by the line (manual or enabled) and the enabled one.
  unitPrice: string | null
  enabledPrice: string | null
  // Manual line: who authorised exactly this price (null = to authorise).
  authorisedBy: string | null
  // Discount above 3 % on the enabled price: who authorised it.
  discountAuthorisation: DiscountAuthorisation
  onChange: (line: LineDraft) => void
  onPrice: (unitPrice: string | null) => void
  onRemove: (() => void) | null
}) {
  const { referenceId, finishId } = line.catalog
  const { user } = useSession()
  const discountError = lineDiscountError(line, user?.role === 'ADMIN', discountAuthorisation)
  const discountBy = discountAuthorisation && 'by' in discountAuthorisation ? discountAuthorisation.by : null
  const enc = encodeURIComponent
  const availability = useLoad<AvailabilityGroup[]>(referenceId && finishId ? `/sales/availability?referenceId=${enc(referenceId)}&finishId=${enc(finishId)}` : null)
  // Sale price configured by administration (no cost or profit reaches sales).
  const price = useLoad<{ available: boolean; message?: string; unitPrice?: string }>(
    referenceId && finishId
      ? `/sales/price?referenceId=${enc(referenceId)}&finishId=${enc(finishId)}&origin=${line.origin}${line.supplierId ? `&supplierId=${enc(line.supplierId)}` : ''}`
      : null,
  )
  const loadedPrice = referenceId && finishId && price.data?.available ? (price.data.unitPrice ?? null) : null
  useEffect(() => onPrice(loadedPrice), [loadedPrice]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<LineDraft>) => onChange({ ...line, ...patch })
  const forOrigin = (availability.data ?? []).filter((g) => g.origin === line.origin && (!line.supplierId || g.supplier?.id === line.supplierId))
  const unknownGroups = (availability.data ?? []).filter((g) => g.origin === 'UNKNOWN')
  // An order reserves in ONE location: the seller sees their own location
  // first and the rest apart, never one total that mixes them.
  const places = availableByLocation(forOrigin)
  const here = myLocation ? (places.find((p) => p.id === myLocation.id)?.available ?? 0) : null
  const elsewhere = places.filter((p) => p.id !== myLocation?.id && p.available > 0)
  const available = here ?? places.reduce((total, p) => total + p.available, 0)
  const unknown = availableByLocation(unknownGroups)
    .filter((p) => !myLocation || p.id === myLocation.id)
    .reduce((total, p) => total + p.available, 0)
  const wanted = Number(line.quantity)
  const shortHere = myLocation && here !== null && Number.isInteger(wanted) && wanted > here ? wanted : null
  const elsewhereText = elsewhere.map((p) => `${p.name}: ${p.available.toLocaleString('es-CO')}`).join(' · ')
  // Kept from a saved quote (the API still accepts it); not chosen by sales.
  const requiredSupplier = line.supplierId ? suppliers.find((s) => s.id === line.supplierId)?.name ?? 'proveedor exigido' : null
  const vatPercent = Number(decimal(line.taxRatePercent))
  const unitWithVat = unitPrice && DECIMAL.test(decimal(line.taxRatePercent)) ? Math.round(Number(unitPrice) * (100 + vatPercent)) / 100 : null
  const amounts = lineAmounts(line, unitPrice)

  return (
    <fieldset className="card quote-line">
      <legend className="quote-line-title">Renglón {index + 1}</legend>
      <div className="form-grid">
        {/* Typing filters the family list (only the family). */}
        <CatalogSelectors mode="form" searchFamily value={line.catalog} onChange={(catalog) => set({ catalog })} />
        <Field label="Origen requerido" hint="China y Nacional son restricciones distintas aunque coincidan referencia y color.">
          <select value={line.origin} onChange={(e) => set({ origin: e.target.value as MaterialOrigin, supplierId: '' })}>
            <option value="CHINA">China</option>
            <option value="NATIONAL">Nacional</option>
          </select>
        </Field>
        <Field label="Perfiles">
          <input type="number" inputMode="numeric" min={1} value={line.quantity} onChange={(e) => set({ quantity: e.target.value })} />
        </Field>
        <Field label="Precio habilitado sin IVA" hint="Lo fija administración; si no hay, o el caso lo pide, usa precio manual.">
          <input readOnly value={enabledPrice ? `${formatMoney(enabledPrice)} / perfil` : 'Sin precio habilitado'} />
        </Field>
        <Field label="Descuento (%)" hint={discountBy && !discountError ? `Autorizado por ${discountBy}` : undefined}>
          <input inputMode="decimal" value={line.discountPercent} onChange={(e) => set({ discountPercent: e.target.value })} />
          {discountError ? <span className="field-error">{discountError}</span> : null}
        </Field>
        <Field label="IVA de venta (%)" hint="19 % por defecto; puedes cambiarlo.">
          <input inputMode="decimal" value={line.taxRatePercent} onChange={(e) => set({ taxRatePercent: e.target.value })} />
        </Field>
      </div>
      <label className="check manual-toggle">
        <input
          type="checkbox"
          checked={line.manual}
          onChange={(e) => set({ manual: e.target.checked, ...(e.target.checked && !line.manualPrice && enabledPrice ? { manualPrice: String(Number(enabledPrice)) } : {}) })}
        />{' '}
        Precio manual (requiere autorización de un administrador)
      </label>
      {line.manual ? (
        <div className="manual-price">
          <div className="form-grid">
            <Field label="Precio manual sin IVA (por perfil)">
              <input inputMode="decimal" value={line.manualPrice} onChange={(e) => set({ manualPrice: e.target.value })} />
            </Field>
            <Field label="Costo de compra estimado (opcional)" hint="Por perfil; el administrador ve el margen.">
              <input inputMode="decimal" value={line.estimatedCost} onChange={(e) => set({ estimatedCost: e.target.value })} />
            </Field>
          </div>
          <Field
            label="¿Por qué el precio es manual?"
            hint="Obligatorio. Ej.: «No hay disponibilidad aquí; Aluminios XYZ nos lo deja a $9.000; vendiendo a $12.000 ganamos 25 %» o «Cliente especial con precio acordado»."
          >
            <textarea rows={3} maxLength={1000} value={line.priceReason} onChange={(e) => set({ priceReason: e.target.value })} />
          </Field>
          {line.manualPrice && !linePrice(line, null) ? <p className="field-error">{MONEY_HINT}</p> : null}
          {line.priceReason.trim().length > 0 && line.priceReason.trim().length < PRICE_REASON_MIN ? (
            <p className="field-error">Explica un poco más (mínimo {PRICE_REASON_MIN} caracteres).</p>
          ) : null}
          <p className={authorisedBy ? 'manual-status manual-ok' : 'manual-status'}>
            {authorisedBy ? `✓ Precio autorizado por ${authorisedBy}` : 'Sin autorizar: al guardar se envía la solicitud al administrador que elijas.'}
            {marginText(linePrice(line, null), parseMoney(line.estimatedCost)) ? ` · Margen estimado ${marginText(linePrice(line, null), parseMoney(line.estimatedCost))}` : ''}
          </p>
        </div>
      ) : null}
      <div className="quote-line-info">
        {availability.data ? (
          <span>
            Disponible {ORIGIN_LABEL[line.origin]}{line.supplierId ? ' de ese proveedor' : ''}
            {myLocation ? ` en ${myLocation.name} (tu ubicación)` : ''}: <strong>{available.toLocaleString('es-CO')}</strong> perfiles
            {unknown > 0 ? ` · ${unknown.toLocaleString('es-CO')} más de origen desconocido (no se usan sin clasificar)` : ''}
            {!myLocation && elsewhere.length > 0 ? ` (${elsewhereText})` : ''}
          </span>
        ) : null}
        {availability.data && myLocation && elsewhere.length > 0 ? <span>En otras ubicaciones: {elsewhereText}</span> : null}
        {availability.data && shortHere && myLocation ? (
          <span className="stock-warning">
            En {myLocation.name} no alcanza para {shortHere.toLocaleString('es-CO')} perfiles.{' '}
            {elsewhere.length > 0
              ? 'La orden se reserva en una sola ubicación: al confirmarla elige de dónde sale el material o pide un traslado.'
              : 'Si se confirma así, la orden queda pendiente de abastecimiento.'}
          </span>
        ) : null}
        {requiredSupplier ? <span>Proveedor exigido: {requiredSupplier}</span> : null}
        {unitWithVat !== null ? (
          <span>
            Precio unitario con IVA de venta: <strong>{formatMoney(unitWithVat)}</strong>
          </span>
        ) : null}
        {amounts ? (
          <span>
            Subtotal sin IVA {formatMoney(amounts.subtotal)}
            {amounts.discount > 0 ? ` · Descuento ${formatMoney(amounts.discount)}` : ''} · IVA {formatMoney(amounts.tax)} ·{' '}
            <strong>Total {formatMoney(amounts.total)}</strong>
          </span>
        ) : null}
        {price.data && !price.data.available && !line.manual ? <span className="field-error">{price.data.message} También puedes usar precio manual.</span> : null}
        {price.error ? <span className="field-error">{price.error}</span> : null}
        {onRemove ? <button type="button" className="text-button danger" onClick={onRemove}>Quitar renglón</button> : null}
      </div>
    </fieldset>
  )
}

export function QuoteView({ id, navigate }: { id?: string; navigate: Navigate }) {
  const existing = useLoad<Quote>(id ? `/quotes/${encodeURIComponent(id)}` : null)
  if (id && existing.loading && !existing.data) return <Loading />
  if (id && existing.error && !existing.data) return <Notice kind="error">{existing.error}</Notice>
  // The editor starts from the saved quote (remounted when it changes).
  return (
    <QuoteEditor
      key={
        existing.data
          ? `${existing.data.id}:${existing.data.status}:${existing.data.total}:${existing.data.lines.length}:${existing.data.globalDiscountPercent}:${existing.data.discountRequests[0]?.id ?? ''}:${existing.data.discountRequests[0]?.status ?? ''}`
          : 'new'
      }
      id={id}
      quote={existing.data}
      reload={existing.reload}
      navigate={navigate}
    />
  )
}

function QuoteEditor({ id, quote, reload, navigate }: { id?: string; quote: Quote | null; reload: () => void; navigate: Navigate }) {
  const { request, user } = useSession()
  const isAdmin = user?.role === 'ADMIN'
  const suppliers = useLoad<Supplier[]>('/suppliers?active=true')
  const myLocationId = user?.defaultInventoryLocationId ?? null
  const locations = useLoad<{ id: string; name: string }[]>(myLocationId ? '/locations/inventory-locations' : null)
  const myLocationName = locations.data?.find((l) => l.id === myLocationId)?.name
  const myLocation = myLocationId && myLocationName ? { id: myLocationId, name: myLocationName } : null
  const [customer, setCustomer] = useState<Pick<Customer, 'id' | 'name' | 'taxId'> | null>(
    quote ? { id: quote.customerId, name: quote.customerName, taxId: quote.customer?.taxId ?? null } : null,
  )
  const customerId = customer?.id ?? ''
  const [newCustomer, setNewCustomer] = useState<{ name: string; taxId: string } | null>(null)
  const [validUntil, setValidUntil] = useState(quote?.validUntil?.slice(0, 10) ?? '')
  const [notes, setNotes] = useState(quote?.notes ?? '')
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | ''>(quote?.paymentMethod ?? '')
  const [paymentTerms, setPaymentTerms] = useState(quote?.paymentTerms ?? '')
  const [lines, setLines] = useState<LineDraft[]>(() =>
    quote
      ? quote.lines.map((line) => ({
          key: line.id,
          catalog: { familyId: '', referenceId: line.referenceId, finishId: line.finishId },
          origin: line.origin,
          supplierId: line.supplierId ?? '',
          quantity: String(line.quantity),
          discountPercent: line.discountPercent,
          taxRatePercent: line.taxRatePercent,
          manual: line.manualPrice,
          manualPrice: line.manualPrice ? String(Number(line.unitPrice)) : '',
          priceReason: line.priceReason ?? '',
          estimatedCost: line.estimatedUnitCost ? String(Number(line.estimatedUnitCost)) : '',
        }))
      : [newLine()],
  )
  // «Detal» / «Ventanería» and its labour (assembly, installation).
  const [saleType, setSaleType] = useState<SaleType>(quote?.saleType ?? 'RETAIL')
  const [assembly, setAssembly] = useState(quote && Number(quote.assemblyAmount) > 0 ? String(Number(quote.assemblyAmount)) : '')
  const [installation, setInstallation] = useState(quote && Number(quote.installationAmount) > 0 ? String(Number(quote.installationAmount)) : '')
  // Labour removed when switching to «Detal» (shown, never silent).
  const [labourCleared, setLabourCleared] = useState<string | null>(null)
  // Large labour amounts the user already confirmed once.
  const [confirmedLarge, setConfirmedLarge] = useState<string | null>(null)
  const [largeWarning, setLargeWarning] = useState<string | null>(null)
  // Global discount of the whole quote (after line discounts, before IVA).
  const [globalDiscount, setGlobalDiscount] = useState(quote ? String(Number(quote.globalDiscountPercent)) : '0')
  const pendingPrice = quote?.discountRequests.find((r) => r.kind === 'MANUAL_PRICE' && r.status === 'PENDING') ?? null
  const [approverId, setApproverId] = useState(pendingPrice?.approver.id ?? '')
  const [discountReason, setDiscountReason] = useState('')
  // The API refused a save that cancels an open manual-price request: the
  // user confirms losing its progress.
  const [confirmReplace, setConfirmReplace] = useState(false)
  // Configured sale price per line key, reported by each line editor.
  const [prices, setPrices] = useState<Record<string, string | null>>({})
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const convertKey = useRef<string | null>(null)
  // Converting: payment method (required for the order) and whether it
  // needs an electronic invoice (then the customer needs NIT / ID and e-mail).
  // `cash` / `transfer`: split of a «Contado – efectivo y transferencia», as typed.
  const [converting, setConverting] = useState<{
    method: PaymentMethod | ''
    terms: string
    billing: boolean
    taxId: string
    email: string
    cash: string
    transfer: string
    // Where the transfer (or its part) was received: required, never preset.
    entity: string
    // Part paid with the customer's saldo a favor (from returns); '' = none.
    credit: string
  } | null>(null)
  // One request at a time: a double click must not create two quotes (the
  // state update of `busy` arrives one render too late to stop it).
  const inFlight = useRef(false)
  const once = async (work: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      await work()
    } finally {
      inFlight.current = false
    }
  }

  useUnsavedWork(dirty ? 'Cotización con cambios sin guardar' : null)

  // The seller sees here the answers to its requests: the menu notice of
  // those answers goes away.
  const answeredForMe = (quote?.discountRequests ?? []).filter(
    (r) => r.requestedBy.id === user?.id && (r.status === 'APPROVED' || r.status === 'REJECTED'),
  ).length
  useEffect(() => {
    if (!quote || answeredForMe === 0) return
    request<{ seen: number }>(`/quotes/${encodeURIComponent(quote.id)}/request-updates/seen`, { method: 'POST' })
      .then(({ data }) => {
        if (data.seen > 0) notifyRequestUpdatesChanged()
      })
      .catch(() => undefined)
  }, [quote?.id, answeredForMe, request]) // eslint-disable-line react-hooks/exhaustive-deps

  const editable = !id || quote?.status === 'DRAFT'
  const globalValue = decimal(globalDiscount || '0')
  const globalValid = validGlobalDiscount(globalValue)
  const draftAmounts = lines.map((line) => lineAmounts(line, linePrice(line, prices[line.key] ?? null)))
  // Base of the global discount as drafted (subtotal − line discounts), in cents.
  const draftBaseCents = draftAmounts.every((amounts) => amounts !== null)
    ? (draftAmounts as Amounts[]).reduce((total, amounts) => total + Math.round((amounts.subtotal - amounts.discount) * 100), 0)
    : null
  // A global discount an administrator authorised covers its percentage
  // while the base does not grow (the API's rule).
  const approvedGlobal = quote?.globalDiscountApprovedPercent ? Number(quote.globalDiscountApprovedPercent) : null
  const approvedBaseCents = quote?.globalDiscountApprovedBase ? Math.round(Number(quote.globalDiscountApprovedBase) * 100) : null
  const approvalOutgrown =
    !isAdmin && approvedGlobal !== null && approvedGlobal > SELLER_GLOBAL_DISCOUNT_LIMIT && approvedBaseCents !== null && draftBaseCents !== null && draftBaseCents > approvedBaseCents
  // What this user applies without asking (SALES: 3 %, or what was approved).
  const globalLimit = isAdmin
    ? 100
    : draftBaseCents === null
      ? quote
        ? Number(quote.globalDiscountLimit)
        : SELLER_GLOBAL_DISCOUNT_LIMIT
      : approvedGlobal !== null && !approvalOutgrown
        ? Math.max(SELLER_GLOBAL_DISCOUNT_LIMIT, approvedGlobal)
        : SELLER_GLOBAL_DISCOUNT_LIMIT
  const needsApproval = !isAdmin && globalValid && Number(globalValue) > globalLimit
  const pendingDiscount = quote?.discountRequests.find((r) => r.kind === 'GLOBAL_DISCOUNT' && r.status === 'PENDING') ?? null
  const pendingRequest = quote?.discountRequests.find((r) => r.status === 'PENDING') ?? null
  // Asking: the quote keeps the discount it already has until approval (no
  // more than this user may apply alone at the drafted base).
  const appliedGlobal = quote ? String(Math.min(Number(quote.globalDiscountPercent), globalLimit)) : '0'
  const willRequest = needsApproval && !pendingDiscount
  // Who authorised each manual draft line exactly as it is (same rule as the API).
  const authorisedBy = (() => {
    const pool = new Map<string, string[]>()
    for (const saved of quote?.lines ?? []) {
      if (!saved.manualPrice || !saved.manualApprovedBy) continue
      const key = savedKey(saved)
      pool.set(key, [...(pool.get(key) ?? []), saved.manualApprovedBy.name])
    }
    return Object.fromEntries(lines.map((line) => [line.key, line.manual ? (pool.get(draftKey(line))?.shift() ?? (isAdmin ? user?.name ?? null : null)) : null]))
  })()
  const manualToAuthorise = !isAdmin && lines.some((line) => line.manual && !authorisedBy[line.key])
  const manualValid = lines.every((line) => !line.manual || (linePrice(line, null) !== null && line.priceReason.trim().length >= PRICE_REASON_MIN && (!line.estimatedCost.trim() || (DECIMAL.test(parseMoney(line.estimatedCost)) && Number(parseMoney(line.estimatedCost)) > 0))))
  const discountApprovals = discountAuthorisations(quote?.lines ?? [], lines)
  const discountsValid = lines.every((line) => lineDiscountError(line, isAdmin, discountApprovals[line.key]) === null)
  // Unauthorised manual lines as drafted vs. as saved (what an open request
  // covers): a difference means a new request (and losing the open one).
  const draftUnauthorised = lines
    .map((line, index) => (line.manual && !authorisedBy[line.key] ? `${index + 1}:${draftKey(line)}` : null))
    .filter(Boolean)
    .join('|')
  const savedUnauthorised = (quote?.lines ?? [])
    .filter((line) => line.manualPrice && !line.manualApprovedBy)
    .map((line) => `${line.lineNo}:${savedKey(line)}`)
    .join('|')
  const manualChanged = draftUnauthorised !== savedUnauthorised
  // Unauthorised manual prices are sent for authorisation on save, unless the
  // open request still covers them as they are.
  const willRequestPrice = manualToAuthorise && (!pendingPrice || manualChanged)
  const needsApprover = willRequest || willRequestPrice
  const approvers = useLoad<{ id: string; name: string }[]>(needsApprover ? '/sales/discount-approvers' : null)
  const unauthorisedSaved = (quote?.lines ?? []).some((line) => line.manualPrice && !line.manualApprovedBy)
  const windows = saleType === 'WINDOWS'
  const assemblyValue = windows ? serviceValue(assembly) : '0'
  const installationValue = windows ? serviceValue(installation) : '0'
  const servicesValid = assemblyValue !== null && installationValue !== null
  const materialTotals = draftAmounts.every((amounts) => amounts !== null)
    ? documentPreview(draftAmounts as Amounts[], globalValid ? Number(needsApproval ? appliedGlobal : globalValue) : 0)
    : null
  const draftTotals =
    materialTotals && servicesValid
      ? {
          ...materialTotals,
          assemblyAmount: assemblyValue,
          installationAmount: installationValue,
          total: (Number(materialTotals.total) + Number(assemblyValue) + Number(installationValue)).toFixed(2),
        }
      : materialTotals
  const update = (index: number, line: LineDraft) => {
    setDirty(true)
    setLines((current) => current.map((item, i) => (i === index ? line : item)))
  }

  const createCustomer = () => once(async () => {
    if (!newCustomer?.name.trim()) return
    try {
      const { data } = await request<Customer>('/customers', { method: 'POST', body: { name: newCustomer.name.trim(), ...(newCustomer.taxId.trim() ? { taxId: newCustomer.taxId.trim() } : {}) } })
      setCustomer(data)
      setDirty(true)
      setNewCustomer(null)
    } catch (err) {
      setError(describeError(err))
    }
  })

  const payload = () => ({
    customerId,
    ...(validUntil ? { validUntil } : {}),
    ...(notes.trim() ? { notes: notes.trim() } : {}),
    ...(paymentMethod ? { paymentMethod } : {}),
    saleType,
    ...(windows ? { assemblyAmount: assemblyValue ?? '0', installationAmount: installationValue ?? '0' } : {}),
    ...(paymentTerms.trim() ? { paymentTerms: paymentTerms.trim() } : {}),
    globalDiscountPercent: needsApproval ? appliedGlobal : globalValue,
    lines: lines.map((line) => ({
      referenceId: line.catalog.referenceId,
      finishId: line.catalog.finishId,
      origin: line.origin,
      ...(line.supplierId ? { supplierId: line.supplierId } : {}),
      quantity: Number(line.quantity),
      discountPercent: decimal(line.discountPercent || '0'),
      taxRatePercent: decimal(line.taxRatePercent),
      ...(line.manual
        ? {
            manualUnitPrice: parseMoney(line.manualPrice),
            priceReason: line.priceReason.trim(),
            ...(line.estimatedCost.trim() ? { estimatedUnitCost: parseMoney(line.estimatedCost) } : {}),
          }
        : {}),
    })),
  })

  const save = (replace = false) => once(async () => {
    const large = [
      ['Ensamble', Number(assemblyValue ?? 0)],
      ['Instalación', Number(installationValue ?? 0)],
    ].filter(([, value]) => Number(value) >= LARGE_SERVICE) as [string, number][]
    const largeKey = `${assemblyValue}|${installationValue}`
    if (large.length > 0 && confirmedLarge !== largeKey) {
      setConfirmedLarge(largeKey)
      setLargeWarning(
        `¿Seguro? ${large.map(([label, value]) => `${label} de ${formatMoney(value)}`).join(' e ')} es un valor alto. Revísalo; si es correcto, pulsa otra vez el botón de guardar.`,
      )
      return
    }
    setLargeWarning(null)
    setBusy(true)
    setError(null)
    setConfirmReplace(false)
    try {
      const { data } = await request<Quote>(id ? `/quotes/${encodeURIComponent(id)}` : '/quotes', {
        method: id ? 'PATCH' : 'POST',
        body: { ...payload(), ...(replace ? { replacePendingPriceRequest: true } : {}) },
      })
      setDirty(false)
      const stillPending = data.discountRequests.some((r) => r.kind === 'MANUAL_PRICE' && r.status === 'PENDING')
      if (!isAdmin && data.lines.some((line) => line.manualPrice && !line.manualApprovedBy) && !stillPending) {
        try {
          await request(`/quotes/${encodeURIComponent(data.id)}/price-requests`, { method: 'POST', body: { approverId } })
        } catch (err) {
          setError(`La cotización se guardó, pero la solicitud de precio manual no se envió: ${describeError(err)}`)
        }
      }
      if (willRequest) {
        try {
          await request(`/quotes/${encodeURIComponent(data.id)}/discount-requests`, {
            method: 'POST',
            body: { percent: globalValue, approverId, ...(discountReason.trim() ? { reason: discountReason.trim() } : {}) },
          })
        } catch (err) {
          setError(`La cotización se guardó, pero la solicitud de descuento no se envió: ${describeError(err)}`)
        }
      }
      if (!id) navigate({ name: 'quote', id: data.id })
      else reload()
    } catch (err) {
      // An open manual-price request would be lost: ask first.
      if (err instanceof ApiError && err.status === 409 && /se pierde su avance/.test(describeError(err))) setConfirmReplace(true)
      else setError(describeError(err))
    } finally {
      setBusy(false)
    }
  })

  const convert = (payment: {
    method: PaymentMethod
    terms: string
    billing: boolean
    customerData: { taxId: string; email: string } | null
    split: { cashAmount: string; transferAmount: string } | null
    transferEntityId: string | null
    creditAmount: string | null
  }) => once(async () => {
    if (!id) return
    setBusy(true)
    setError(null)
    convertKey.current ??= uuid()
    try {
      if (payment.billing && payment.customerData && quote) {
        await request(`/customers/${encodeURIComponent(quote.customerId)}/billing-data`, { method: 'PATCH', body: payment.customerData })
      }
      const { data } = await request<{ id: string }>(`/quotes/${encodeURIComponent(id)}/convert`, {
        method: 'POST',
        body: {
          operationKey: convertKey.current,
          paymentMethod: payment.method,
          paymentTerms: payment.terms.trim(),
          ...(payment.billing ? { requiresBilling: true } : {}),
          ...(payment.split ?? {}),
          ...(payment.transferEntityId ? { transferEntityId: payment.transferEntityId } : {}),
          ...(payment.creditAmount ? { creditAmount: payment.creditAmount } : {}),
        },
      })
      navigate({ name: 'order', id: data.id })
    } catch (err) {
      // Lost answer: keep the key; the retry returns the same order.
      if (!(err instanceof ApiError && (err.status === 0 || err.status >= 500))) convertKey.current = null
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  })

  const cancel = () => once(async () => {
    if (!id) return
    try {
      await request(`/quotes/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
      reload()
    } catch (err) {
      setError(describeError(err))
    }
  })
  // Billing needs the customer's NIT / ID and e-mail (asked in the dialog).
  const customerNeedsData = !quote?.customer?.taxId?.trim() || !quote?.customer?.email?.trim()
  const billingDataMissing = Boolean(converting?.billing && customerNeedsData && (!converting.taxId.trim() || !converting.email.trim()))
  // «Contado – efectivo y transferencia»: a free split that must add up to the
  // total (the API checks it again). In cents, never with float sums.
  const toCents = (value: string) => {
    const text = parseMoney(value)
    return /^\d{1,12}(\.\d{1,2})?$/.test(text) ? Math.round(Number(text) * 100) : null
  }
  const totalCents = Math.round(Number(quote?.total ?? 0) * 100)
  // Saldo a favor of the customer (from returns): may pay part or all of it.
  const customerCredit = useLoad<{ available: string }>(converting && quote ? `/customers/${encodeURIComponent(quote.customerId)}/credit` : null)
  const availableCents = Math.round(Number(customerCredit.data?.available ?? 0) * 100)
  const creditText = converting?.credit.trim() ?? ''
  const creditCents = creditText ? toCents(creditText) : 0
  const creditProblem =
    creditCents === null
      ? 'escribe el saldo a favor a usar en pesos'
      : creditCents > availableCents
        ? `el cliente tiene ${formatMoney(availableCents / 100)} de saldo a favor`
        : creditCents > totalCents
          ? 'el saldo a favor usado no puede superar el total'
          : null
  // What is left to pay after the saldo a favor.
  const restCents = totalCents - (creditCents ?? 0)
  const mixed = converting?.method === 'CASH_TRANSFER' && restCents > 0
  const cashCents = mixed ? toCents(converting.cash) : null
  const transferCents = mixed ? toCents(converting.transfer) : null
  const splitRemaining = restCents - (cashCents ?? 0) - (transferCents ?? 0)
  // «Poner lo que falta»: the exact rest (cents included) in one medium, given
  // what the other one already has, so nobody has to type the cents.
  // Offered only once the other medium has an amount (a split needs both).
  const cashFill = transferCents && transferCents > 0 ? restCents - transferCents : 0
  const transferFill = cashCents && cashCents > 0 ? restCents - cashCents : 0
  const splitProblem = !mixed
    ? null
    : cashCents === null || transferCents === null
      ? 'escribe cuánto se pagó en efectivo y cuánto por transferencia'
      : cashCents <= 0 || transferCents <= 0
        ? 'ambos valores deben ser mayores que cero (si fue un solo medio, elige contado en efectivo o por transferencia)'
        : splitRemaining !== 0
          ? creditCents
            ? 'la suma debe ser igual a lo que queda después del saldo a favor'
            : 'la suma debe ser igual al total de la orden'
          : null
  // A transfer (whole or the transferred part) says where it was received.
  const needsEntity = (converting?.method === 'TRANSFER' || converting?.method === 'CASH_TRANSFER') && restCents > 0
  const transferEntities = useLoad<TransferEntity[]>(converting && needsEntity ? '/transfer-entities' : null)
  const convertProblem = creditProblem ?? splitProblem ?? (needsEntity && !converting?.entity ? 'selecciona dónde se recibió la transferencia' : null)
  const entityField = converting && needsEntity ? (
    <Field label={ENTITY_QUESTION} hint={transferEntities.error ?? 'La entidad de Solaluminios que recibió el dinero (no la del cliente).'}>
      <select required value={converting.entity} disabled={busy} onChange={(e) => setConverting({ ...converting, entity: e.target.value })}>
        <option value="">{ENTITY_PLACEHOLDER}</option>
        {(transferEntities.data ?? []).map((entity) => (
          <option key={entity.id} value={entity.id}>{entity.name}</option>
        ))}
      </select>
    </Field>
  ) : null
  // What is missing to save, shown next to the button (a tooltip is not
  // visible on phones).
  const blocker = !customerId
    ? 'Elige el cliente.'
    : !discountsValid
        ? 'Revisa el descuento de los renglones marcados.'
        : !servicesValid
          ? 'Revisa los valores de ensamble e instalación.'
        : !globalValid
          ? 'El descuento global debe ser 0 o estar entre 0,1 y 100.'
          : !manualValid
            ? 'Completa el precio manual y su justificación.'
            : needsApprover && !approverId
              ? 'Elige el administrador que autoriza.'
              : null

  return (
    <>
      <PageHeader
        eyebrow="Ventas · Cotización"
        title={quote ? quote.number : 'Nueva cotización'}
        description="Elige referencia, acabado, cantidad y origen: el precio de venta lo habilita administración. Guardar una cotización no reserva ni descuenta inventario. Los precios se calculan en el servidor y se conservan con sus condiciones."
        actions={
          <>
            {quote && (isAdmin || !unauthorisedSaved) ? <DownloadPdfButton path={`/quotes/${encodeURIComponent(quote.id)}/pdf`} fallbackName={quote.number} /> : null}
            <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'sales' })}>
              Volver a ventas
            </button>
          </>
        }
      />
      {quote ? (
        <p className="doc-facts">
          <span>Modalidad: <strong>{SALE_TYPE_LABEL[quote.saleType ?? 'RETAIL']}{hasLabour(quote) ? ' · con mano de obra' : ''}</strong></span>
          <span>Forma de pago: <strong>{quote.paymentMethod ? paymentLabel(quote) : 'por definir (se elige al convertir en orden de venta)'}</strong></span>
          {isAdmin && quote.createdBy ? (
            <span>Creada por <strong>{quote.createdBy.name}</strong> · {formatDateTime(quote.createdAt)}</span>
          ) : null}
        </p>
      ) : null}
      {quote && unauthorisedSaved && !pendingPrice && quote.status === 'DRAFT' ? (
        <Notice kind="warning">
          La cotización tiene precios manuales sin autorizar: no se descarga en PDF ni se convierte en orden hasta que un administrador los apruebe.
        </Notice>
      ) : null}
      {quote ? <DiscountRequests quote={quote} onChanged={reload} /> : null}
      {quote && quote.status !== 'DRAFT' ? (
        <Notice kind="info">
          {quote.status === 'CONVERTED' && quote.order ? (
            <>
              Convertida en la orden{' '}
              <button type="button" className="link" onClick={() => navigate({ name: 'order', id: quote.order!.id })}>{quote.order.number}</button>.
            </>
          ) : (
            'Cotización cancelada.'
          )}
        </Notice>
      ) : null}

      <section className="card">
        <fieldset className="sale-type" disabled={!editable}>
          <legend>Modalidad</legend>
          {(['RETAIL', 'WINDOWS'] as const).map((type) => (
            <label key={type} className={saleType === type ? 'sale-type-option selected' : 'sale-type-option'}>
              <input
                type="radio"
                name="sale-type"
                checked={saleType === type}
                onChange={() => {
                  setSaleType(type)
                  setDirty(true)
                  if (type === 'RETAIL' && (assembly.trim() || installation.trim())) {
                    const shown = (text: string) => (serviceValue(text) !== null ? formatMoney(Number(serviceValue(text))) : text.trim())
                    const removed = [assembly.trim() ? `ensamble (${shown(assembly)})` : null, installation.trim() ? `instalación (${shown(installation)})` : null].filter(Boolean).join(' e ')
                    setLabourCleared(`Se quitó ${removed}: en Detal no se cobra mano de obra.`)
                    setAssembly('')
                    setInstallation('')
                  } else {
                    setLabourCleared(null)
                  }
                }}
              />
              <span>
                <strong>{SALE_TYPE_LABEL[type]}</strong>
                <small>{type === 'RETAIL' ? 'Materiales y accesorios.' : 'Materiales y accesorios, con ensamble e instalación si se cobran.'}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {labourCleared ? <Notice kind="warning">{labourCleared}</Notice> : null}
        <div className="form-grid">
          <Field label="Cliente" hint={editable ? 'Busca por nombre o NIT y elige uno de los resultados.' : undefined}>
            <CustomerPicker
              selected={customer}
              disabled={!editable}
              onSelect={(picked) => {
                setCustomer(picked)
                setDirty(true)
              }}
            />
          </Field>
          <Field label="Válida hasta">
            <input type="date" value={validUntil} disabled={!editable} onChange={(e) => { setValidUntil(e.target.value); setDirty(true) }} />
          </Field>
          <Field label="Notas">
            <input value={notes} disabled={!editable} maxLength={1000} onChange={(e) => { setNotes(e.target.value); setDirty(true) }} />
          </Field>
          <Field label="Forma de pago (opcional)" hint="Si es solo una consulta, déjala sin elegir: se pide al convertir en orden de venta.">
            <select value={paymentMethod} disabled={!editable} onChange={(e) => { setPaymentMethod(e.target.value as PaymentMethod | ''); setDirty(true) }}>
              <option value="">Por definir</option>
              {(Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[]).map((method) => (
                <option key={method} value={method}>{PAYMENT_METHOD_LABEL[method]}</option>
              ))}
            </select>
          </Field>
          <Field label="Condiciones de pago" hint={paymentMethod ? PAYMENT_TERMS_HINT[paymentMethod] : 'Opcional.'}>
            <input value={paymentTerms} disabled={!editable} maxLength={300} onChange={(e) => { setPaymentTerms(e.target.value); setDirty(true) }} />
          </Field>
        </div>
        {editable ? (
          newCustomer ? (
            <div className="form-grid">
              <Field label="Nombre del cliente nuevo">
                <input value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} />
              </Field>
              <Field label="NIT (opcional)">
                <input value={newCustomer.taxId} onChange={(e) => setNewCustomer({ ...newCustomer, taxId: e.target.value })} />
              </Field>
              <div className="actions">
                <button type="button" className="button button-secondary" onClick={() => void createCustomer()}>Crear cliente</button>
                <button type="button" className="text-button" onClick={() => setNewCustomer(null)}>Cancelar</button>
              </div>
            </div>
          ) : (
            <button type="button" className="text-button" onClick={() => setNewCustomer({ name: '', taxId: '' })}>+ Cliente nuevo</button>
          )
        ) : null}
      </section>

      {editable ? (
        <>
          {lines.map((line, index) => (
            <LineEditor
              key={line.key}
              line={line}
              index={index}
              suppliers={suppliers.data ?? []}
              unitPrice={linePrice(line, prices[line.key] ?? null)}
              enabledPrice={prices[line.key] ?? null}
              authorisedBy={authorisedBy[line.key]}
              discountAuthorisation={discountApprovals[line.key]}
              myLocation={myLocation}
              onChange={(next) => update(index, next)}
              onPrice={(price) => setPrices((current) => (current[line.key] === price ? current : { ...current, [line.key]: price }))}
              onRemove={lines.length > 1 ? () => { setDirty(true); setLines((current) => current.filter((_, i) => i !== index)) } : null}
            />
          ))}
          <button type="button" className="button button-secondary" onClick={() => { setDirty(true); setLines((current) => [...current, newLine()]) }}>
            + Agregar renglón
          </button>
          {windows ? (
            <section className="card labour">
              <h2 className="subtitle">Mano de obra (Ventanería)</h2>
              <p className="cell-sub">Valor total de cada servicio cotizado, sin IVA y sin descuentos. Déjalo vacío si no se cobra.</p>
              <div className="form-grid">
                <Field label="Ensamble" hint="Armar la ventana en el taller.">
                  <input inputMode="decimal" placeholder="Ej. 150.000" value={assembly} onChange={(e) => { setAssembly(e.target.value); setDirty(true); setLargeWarning(null) }} />
                  {assemblyValue === null ? <span className="field-error">{MONEY_HINT}</span> : null}
                </Field>
                <Field label="Instalación" hint="Instalar la ventana en la obra.">
                  <input inputMode="decimal" placeholder="Ej. 90.000" value={installation} onChange={(e) => { setInstallation(e.target.value); setDirty(true); setLargeWarning(null) }} />
                  {installationValue === null ? <span className="field-error">{MONEY_HINT}</span> : null}
                </Field>
              </div>
            </section>
          ) : null}
          <section className="card">
            <div className="form-grid">
              <Field
                label="Descuento global (%)"
                hint={
                  isAdmin
                    ? 'Sobre toda la cotización: después de los descuentos por renglón y antes del IVA.'
                    : `Sobre toda la cotización, antes del IVA. Hasta ${formatPercent(globalLimit)} lo aplicas tú; más requiere autorización de un administrador.`
                }
              >
                <input inputMode="decimal" value={globalDiscount} onChange={(e) => { setGlobalDiscount(e.target.value); setDirty(true) }} />
                {globalValid ? null : <span className="field-error">Escribe 0 o un porcentaje entre 0,1 y 100, p. ej. 2 o 2,5.</span>}
              </Field>
              {willRequest ? (
                <Field label="Motivo del descuento para el administrador (opcional)">
                  <input value={discountReason} maxLength={500} onChange={(e) => setDiscountReason(e.target.value)} />
                </Field>
              ) : null}
            </div>
            {!globalValid ? <p className="field-error">Usa 0 o un porcentaje entre 0,1 y 100, con hasta 2 decimales.</p> : null}
            {quote?.globalDiscountApprovedBy && approvedGlobal !== null && approvedGlobal > SELLER_GLOBAL_DISCOUNT_LIMIT && !approvalOutgrown ? (
              <p className="cell-sub">
                {quote.globalDiscountApprovedBy.name} autorizó hasta {formatPercent(approvedGlobal)} de descuento global mientras el valor de los materiales (sin IVA ni
                descuentos por renglón) no supere {formatMoney(quote.globalDiscountApprovedBase ?? 0)}.
              </p>
            ) : null}
            {approvalOutgrown && Number(globalValue) > SELLER_GLOBAL_DISCOUNT_LIMIT ? (
              <Notice kind="warning">
                {quote?.globalDiscountApprovedBy?.name ?? 'Un administrador'} autorizó {formatPercent(approvedGlobal ?? 0)} para un valor de materiales de hasta{' '}
                {formatMoney(quote?.globalDiscountApprovedBase ?? 0)}; con estos cambios es {formatMoney((draftBaseCents ?? 0) / 100)}. Ese descuento ya no cubre la
                cotización: hay que pedir la autorización de nuevo.
              </Notice>
            ) : null}
            {willRequest ? (
              <Notice kind="warning">
                Más de {formatPercent(globalLimit)} necesita autorización. La cotización se guarda con {formatPercent(appliedGlobal)} de descuento global y la
                solicitud de {formatPercent(globalValue)} le llega como tarea al administrador que elijas. Si la aprueba, el descuento se aplica solo.
              </Notice>
            ) : null}
            {needsApproval && pendingDiscount ? (
              <Notice kind="warning">
                Ya hay una solicitud pendiente de {formatPercent(pendingDiscount?.requestedPercent ?? 0)}. Espera la respuesta o cancélala para pedir otro porcentaje;
                al guardar se conserva {formatPercent(appliedGlobal)}.
              </Notice>
            ) : null}
          </section>
          {needsApprover ? (
            <section className="card">
              <div className="form-grid">
                <Field label="Administrador que autoriza" hint="Recibe la solicitud como tarea; solo esa persona puede responderla.">
                  <select value={approverId} onChange={(e) => setApproverId(e.target.value)}>
                    <option value="">Elige…</option>
                    {(approvers.data ?? []).map((admin) => (
                      <option key={admin.id} value={admin.id}>{admin.name}</option>
                    ))}
                  </select>
                </Field>
              </div>
              {willRequestPrice ? (
                <Notice kind="warning">
                  {pendingPrice
                    ? 'Cambiaste un precio manual que está en solicitud: al guardar se cancela la solicitud en curso (se pierde su avance) y se envía una nueva.'
                    : 'Hay precios manuales sin autorizar: al guardar, la solicitud le llega como tarea al administrador que elijas. Hasta que la apruebe no hay PDF ni orden de venta.'}
                </Notice>
              ) : null}
              {approvers.error ? <p className="field-error">{approvers.error}</p> : null}
            </section>
          ) : null}
          {draftTotals ? (
            <p className="quote-totals">
              {totalsParts(draftTotals)} · <strong>Total {formatMoney(draftTotals.total)}</strong>
            </p>
          ) : null}
        </>
      ) : null}

      {quote ? (
        <section className="card">
          <h2 className="subtitle">Condiciones guardadas</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Material</th><th>Origen</th><th className="num">Perfiles</th><th>Precio</th><th className="num">Unitario</th><th className="num">Desc.</th><th className="num">IVA</th><th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {quote.lines.map((line) => (
                  <tr key={line.id}>
                    <td data-label="#">{line.lineNo}</td>
                    <td data-label="Material">{line.referenceCode} · {line.finishDescription ?? line.finishCode}</td>
                    <td data-label="Origen">{ORIGIN_LABEL[line.origin]}{line.supplierName ? ` · ${line.supplierName}` : ''}</td>
                    <td className="num" data-label="Perfiles">{line.quantity}</td>
                    <td data-label="Precio">
                      {line.manualPrice ? (
                        <>
                          Precio manual {line.manualApprovedBy ? `· autorizado por ${line.manualApprovedBy.name}` : '· sin autorizar'}
                          {line.priceReason ? <span className="cell-sub"> {line.priceReason}</span> : null}
                          {line.estimatedUnitCost ? <span className="cell-sub"> costo estimado {formatUnitCost(line.estimatedUnitCost)}</span> : null}
                        </>
                      ) : (
                        <>
                          {line.pricingMethod ? PRICING_LABEL[line.pricingMethod] : 'Precio configurado'}
                          {line.pricingPercent ? ` ${Number(line.pricingPercent)} %` : ''}
                          {line.costBasis ? <span className="cell-sub"> costo base {formatUnitCost(line.costBasis)}</span> : null}
                        </>
                      )}
                    </td>
                    <td className="num" data-label="Unitario">{formatMoney(line.unitPrice)}</td>
                    <td className="num" data-label="Desc.">
                      {formatMoney(line.discountAmount)}
                      {line.discountApprovedBy ? <span className="cell-sub"> {formatPercent(Number(line.discountPercent))} autorizado por {line.discountApprovedBy.name}</span> : null}
                    </td>
                    <td className="num" data-label="IVA">{formatMoney(line.taxAmount)}</td>
                    <td className="num" data-label="Total">{formatMoney(line.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="quote-totals">
            {totalsParts(quote)} · <strong>Total {formatMoney(quote.total)}</strong>
          </p>
          {Number(quote.globalDiscountAmount) > 0 ? (
            <p className="cell-sub">El total de cada renglón ya incluye su parte del descuento global de {formatPercent(quote.globalDiscountPercent)}.</p>
          ) : null}
        </section>
      ) : null}

      {error ? <Notice kind="error">{error}</Notice> : null}
      {largeWarning ? <Notice kind="warning">{largeWarning}</Notice> : null}
      {confirmReplace ? (
        <Notice kind="warning">
          <strong>La cotización tiene una solicitud de precio manual en curso.</strong> Si guardas estos cambios, esa solicitud se cancela y se pierde su avance
          {willRequestPrice ? '; se enviará una nueva al administrador elegido' : ''}.
          <span className="actions">
            <button type="button" className="button button-danger" disabled={busy || (willRequestPrice && !approverId)} onClick={() => void save(true)}>
              Sí, cancelar la solicitud y guardar
            </button>
            <button type="button" className="text-button" disabled={busy} onClick={() => setConfirmReplace(false)}>Volver</button>
          </span>
        </Notice>
      ) : null}
      {editable ? (
        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={busy || blocker !== null}
            title={blocker ?? undefined}
            onClick={() => void save()}
          >
            {busy ? 'Guardando…' : needsApprover ? 'Guardar y solicitar autorización' : id ? 'Guardar cambios' : 'Guardar cotización'}
          </button>
          {blocker && !busy ? <span className="cell-sub save-blocker">Para guardar: {blocker}</span> : null}
          {id && quote?.status === 'DRAFT' ? (
            <>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy || dirty || pendingRequest !== null || unauthorisedSaved}
                title={
                  dirty
                    ? 'Guarda los cambios antes de convertir'
                    : pendingRequest
                      ? 'Hay una solicitud pendiente de autorización'
                      : unauthorisedSaved
                        ? 'Hay precios manuales sin autorizar'
                        : undefined
                }
                onClick={() =>
                  setConverting({
                    method: quote?.paymentMethod ?? '',
                    terms: quote?.paymentTerms ?? paymentTerms,
                    billing: false,
                    taxId: quote?.customer?.taxId ?? '',
                    email: quote?.customer?.email ?? '',
                    cash: '',
                    transfer: '',
                    entity: '',
                    credit: '',
                  })
                }
              >
                Convertir en orden de venta
              </button>
              <button type="button" className="text-button danger" disabled={busy} onClick={() => void cancel()}>Cancelar cotización</button>
            </>
          ) : null}
          {converting ? (
            <div className="confirm convert-payment" role="dialog" aria-label="Forma de pago de la orden de venta">
              <p>
                <strong>¿Cómo va a pagar el cliente?</strong> Es obligatorio para la orden de venta y queda también en la cotización.
              </p>
              <div className="form-grid">
                <Field label="Forma de pago">
                  <select value={converting.method} disabled={busy} onChange={(e) => setConverting({ ...converting, method: e.target.value as PaymentMethod | '' })}>
                    <option value="">Elige…</option>
                    {(Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[]).map((method) => (
                      <option key={method} value={method}>{PAYMENT_METHOD_LABEL[method]}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Condiciones de pago" hint={converting.method ? PAYMENT_TERMS_HINT[converting.method] : 'Opcional.'}>
                  <input value={converting.terms} disabled={busy} maxLength={300} onChange={(e) => setConverting({ ...converting, terms: e.target.value })} />
                </Field>
              </div>
              {availableCents > 0 ? (
                <div className="payment-split">
                  <div className="form-grid">
                    <Field
                      label="Usar saldo a favor (opcional)"
                      hint={`El cliente tiene ${formatMoney(availableCents / 100)} de saldo a favor por devoluciones. Lo que uses se resta de lo que paga.`}
                    >
                      <input
                        inputMode="decimal"
                        placeholder="0"
                        value={converting.credit}
                        disabled={busy}
                        onChange={(e) => setConverting({ ...converting, credit: e.target.value })}
                      />
                    </Field>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => setConverting({ ...converting, credit: String(Math.min(availableCents, totalCents) / 100) })}
                  >
                    Usar {formatMoney(Math.min(availableCents, totalCents) / 100)}
                  </button>
                  {creditCents && creditProblem === null ? (
                    <p className="field-hint" aria-live="polite">
                      Queda por pagar <strong>{formatMoney(restCents / 100)}</strong>
                      {restCents === 0 ? ': el saldo a favor cubre todo.' : '.'}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {mixed ? (
                <div className="payment-split">
                  <div className="form-grid">
                    <Field label="Efectivo recibido">
                      <input
                        inputMode="decimal"
                        placeholder="0"
                        value={converting.cash}
                        disabled={busy}
                        onChange={(e) => setConverting({ ...converting, cash: e.target.value })}
                      />
                      {cashFill > 0 && cashFill !== cashCents ? (
                        <button type="button" className="text-button" disabled={busy} onClick={() => setConverting({ ...converting, cash: typedPesos(cashFill) })}>
                          Poner lo que falta: {formatMoney(cashFill / 100)}
                        </button>
                      ) : null}
                    </Field>
                    <Field label="Transferencia recibida">
                      <input
                        inputMode="decimal"
                        placeholder="0"
                        value={converting.transfer}
                        disabled={busy}
                        onChange={(e) => setConverting({ ...converting, transfer: e.target.value })}
                      />
                      {transferFill > 0 && transferFill !== transferCents ? (
                        <button type="button" className="text-button" disabled={busy} onClick={() => setConverting({ ...converting, transfer: typedPesos(transferFill) })}>
                          Poner lo que falta: {formatMoney(transferFill / 100)}
                        </button>
                      ) : null}
                    </Field>
                    {entityField}
                  </div>
                  <p className={`split-status${splitRemaining === 0 ? ' done' : ''}`} aria-live="polite">
                    {creditCents ? 'Queda por pagar' : 'Total de la orden'} <strong>{formatMoney(restCents / 100)}</strong> ·{' '}
                    {splitRemaining === 0
                      ? 'distribución completa'
                      : splitRemaining > 0
                        ? <>falta por distribuir <strong>{formatMoney(splitRemaining / 100)}</strong></>
                        : <>sobran <strong>{formatMoney(-splitRemaining / 100)}</strong></>}
                  </p>
                  <p className="field-hint">Reparte el total como quieras. Si solo recibió una parte, elige «Abono» y registra lo recibido desde la orden.</p>
                </div>
              ) : restCents <= 0 && converting.method ? (
                <p className="field-hint">El saldo a favor cubre todo el total: no se registra efectivo ni transferencia.</p>
              ) : converting.method === 'CASH' || converting.method === 'TRANSFER' ? (
                <>
                  {converting.method === 'TRANSFER' ? <div className="form-grid">{entityField}</div> : null}
                  <p className="field-hint">
                    Se registra el pago {creditCents ? 'de lo que queda' : 'completo'}, {formatMoney(restCents / 100)}, en {converting.method === 'CASH' ? 'efectivo' : 'transferencia'}, con fecha de hoy. Si solo recibió una parte, elige «Abono».
                  </p>
                </>
              ) : converting.method ? (
                <p className="field-hint">
                  {creditCents ? 'El saldo a favor queda como el primer abono. ' : ''}Cada pago se registra después en la orden con «Agregar abono»: valor, fecha y medio.
                </p>
              ) : null}
              <label className="check billing-check">
                <input type="checkbox" checked={converting.billing} disabled={busy} onChange={(e) => setConverting({ ...converting, billing: e.target.checked })} />
                <span>Requiere facturación</span>
              </label>
              {converting.billing ? (
                customerNeedsData ? (
                  <>
                    <p className="field-hint">Le llega a facturación como tarea, con el PDF de la orden. Para facturar, el cliente necesita NIT o cédula y correo; se guardan en el cliente.</p>
                    <div className="form-grid">
                      <Field label="NIT o cédula">
                        <input value={converting.taxId} maxLength={30} disabled={busy} onChange={(e) => setConverting({ ...converting, taxId: e.target.value })} />
                      </Field>
                      <Field label="Correo para la factura">
                        <input type="email" value={converting.email} maxLength={150} disabled={busy} onChange={(e) => setConverting({ ...converting, email: e.target.value })} />
                      </Field>
                    </div>
                  </>
                ) : (
                  <p className="field-hint">Le llega a facturación como tarea, con el PDF de la orden (NIT {quote?.customer?.taxId} · {quote?.customer?.email}).</p>
                )
              ) : null}
              <div className="actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy || !converting.method || billingDataMissing || convertProblem !== null}
                  title={convertProblem ? `Para convertir: ${convertProblem}` : undefined}
                  onClick={() =>
                    converting.method &&
                    void convert({
                      method: converting.method,
                      terms: converting.terms,
                      billing: converting.billing,
                      customerData: converting.billing && customerNeedsData ? { taxId: converting.taxId.trim(), email: converting.email.trim() } : null,
                      split: mixed ? { cashAmount: parseMoney(converting.cash), transferAmount: parseMoney(converting.transfer) } : null,
                      transferEntityId: needsEntity ? converting.entity : null,
                      creditAmount: creditCents ? String(creditCents / 100) : null,
                    })
                  }
                >
                  {busy ? 'Convirtiendo…' : 'Convertir en orden de venta'}
                </button>
                {convertProblem && !busy ? <span className="cell-sub save-blocker">Para convertir: {convertProblem}</span> : null}
                <button type="button" className="text-button" disabled={busy} onClick={() => setConverting(null)}>Volver</button>
                {!converting.method ? (
                  <span className="cell-sub">Para convertir: elige la forma de pago.</span>
                ) : billingDataMissing ? (
                  <span className="cell-sub">Para facturar: escribe el NIT o cédula y el correo del cliente.</span>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
