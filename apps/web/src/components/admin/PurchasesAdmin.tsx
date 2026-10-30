import { useState } from 'react'
import { describeError } from '../../api/client'
import type { Page } from '../../api/types'
import { ORIGIN_LABEL, formatMoney, formatUnitCost, type MaterialOrigin, type Supplier } from '../../lib/commerce'
import { EMPTY_CATALOG, type CatalogValue } from '../../lib/forms'
import { todayIso } from '../../lib/format'
import { queryString, useLoad } from '../../lib/useLoad'
import { uuid } from '../../lib/uuid'
import { useUnsavedWork } from '../../pwa/workGuard'
import { useSession } from '../../session/session-context'
import { CatalogSelectors } from '../CatalogSelectors'
import { Field, FilterPanel, Notice } from '../ui'

interface PurchaseRow {
  id: string
  documentNumber: string
  documentDate: string
  currency: string
  status: 'DRAFT' | 'CONFIRMED'
  documentTotal: string
  supplier: { name: string }
}

export interface PurchaseLineDetail {
  id: string
  lineNo: number
  referenceId: string
  finishId: string
  origin: MaterialOrigin
  // Current rule: gross WITHOUT VAT -> discount -> VAT on the discounted base.
  taxOnNet: boolean
  // Previous rule: gross WITH VAT -> discount (VAT not separated).
  grossIncludesTax: boolean
  grossAmount: string
  lineDiscountValue: string
  lineDiscountAmount: string
  netAmount: string
  taxRatePercent: string | null
  taxAmount: string
  costAmountCop: string
  profiles: number
  unitCostCop: string | null
  reference: { code: string; description: string | null }
  finish: { code: string; description: string | null }
  lots: { id: string; code: string }[]
}

export interface PurchaseDetail extends PurchaseRow {
  supplierId: string
  grossTotal: string
  lineDiscountTotal: string
  netTotal: string
  taxTotal: string
  issues: string[]
  lines: PurchaseLineDetail[]
}

interface LineDraft {
  key: string
  catalog: CatalogValue
  origin: MaterialOrigin
  quantity: string
  grossAmount: string
  discountPercent: string
  taxRatePercent: string
  lotIds: string
  // The quantity was filled from the selected lots (not typed): it follows
  // the selection until the user edits it.
  quantityFromLots: boolean
}

interface LotOption {
  id: string
  code: string
  origin: MaterialOrigin
  unitCost: string | null
  supplier: { name: string } | null
  reference: { code: string }
  finish: { code: string; description: string | null }
  totals: { bundles: number; profiles: number; inStock: number; pendingBundles: number; pendingProfiles: number }
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString('es-CO')} ${count === 1 ? one : many}`

// What a lot holds: bundles and profiles that came in (an exit does not
// change what the purchase documents) plus, for China, what is still announced.
function lotContents(totals: LotOption['totals']) {
  const parts = [`${plural(totals.bundles, 'paquete', 'paquetes')} · ${plural(totals.profiles, 'perfil', 'perfiles')}`]
  if (totals.pendingBundles > 0) parts.push(`por recibir ${plural(totals.pendingBundles, 'paquete', 'paquetes')} · ${plural(totals.pendingProfiles, 'perfil', 'perfiles')}`)
  return parts.join(' + ')
}

const emptyLine = (): LineDraft => ({
  key: uuid(),
  catalog: EMPTY_CATALOG,
  origin: 'NATIONAL',
  quantity: '',
  grossAmount: '',
  discountPercent: '0',
  // Usual rate, editable (0 if the purchase has no VAT).
  taxRatePercent: '19',
  lotIds: '',
  quantityFromLots: false,
})

const dec = (value: string) => value.trim().replace(',', '.')
const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/

// Preview of the server's rule, in the order of the invoice (the server
// recomputes with decimals on save): discount = gross × % / 100; base =
// gross − discount; VAT = base × VAT % / 100; total = base + VAT; cost per
// profile = total ÷ profiles.
function preview(line: LineDraft) {
  const quantity = Number(line.quantity)
  const gross = dec(line.grossAmount)
  const discount = dec(line.discountPercent || '0')
  const tax = dec(line.taxRatePercent)
  if (!Number.isInteger(quantity) || quantity < 1 || !DECIMAL.test(gross) || !DECIMAL.test(discount) || !DECIMAL.test(tax)) return null
  const grossCents = Math.round(Number(gross) * 100)
  const discountCents = Math.round((grossCents * Number(discount)) / 100)
  const netCents = grossCents - discountCents
  const taxCents = Math.round((netCents * Number(tax)) / 100)
  const totalCents = netCents + taxCents
  return { discount: discountCents / 100, net: netCents / 100, tax: taxCents / 100, total: totalCents / 100, unitCost: totalCents / 100 / quantity }
}

// Profiles a lot documents: what came in plus, for China, what is still announced.
const lotProfiles = (lot: LotOption) => lot.totals.profiles + lot.totals.pendingProfiles

// `onChange` receives the selected lots and their profiles, so the line can
// take its quantity from them.
function LotPicker({ line, onChange }: { line: LineDraft; onChange: (lotIds: string, profiles: number) => void }) {
  const enc = encodeURIComponent
  const lots = useLoad<Page<LotOption>>(
    line.catalog.referenceId && line.catalog.finishId
      ? `/lots?referenceId=${enc(line.catalog.referenceId)}&finishId=${enc(line.catalog.finishId)}&origin=${line.origin}&costPending=true&pageSize=50`
      : null,
  )
  const chosen = line.lotIds ? line.lotIds.split(',') : []
  const items = lots.data?.items ?? []
  const selected = items.filter((lot) => chosen.includes(lot.id))
  const sum = (key: keyof LotOption['totals']) => selected.reduce((total, lot) => total + lot.totals[key], 0)
  const lineProfiles = Number(line.quantity)
  const selectedProfiles = sum('profiles') + sum('pendingProfiles')
  const hint =
    selected.length === 0
      ? 'Lotes de ese material y origen con costo pendiente.'
      : `Seleccionado: ${lotContents({ bundles: sum('bundles'), profiles: sum('profiles'), inStock: sum('inStock'), pendingBundles: sum('pendingBundles'), pendingProfiles: sum('pendingProfiles') })}` +
        (Number.isInteger(lineProfiles) && lineProfiles > 0 && lineProfiles !== selectedProfiles
          ? `. El renglón dice ${plural(lineProfiles, 'perfil', 'perfiles')}: revisa que correspondan.`
          : '.')
  // Checkboxes, not a multiple select: the text wraps, so the contents of
  // each lot stay readable on a phone.
  return (
    <div className="field field-wide">
      <span className="field-label">Lotes que documenta (opcional)</span>
      {items.length === 0 ? (
        <span className="field-hint">{lots.loading ? 'Cargando lotes…' : 'No hay lotes de ese material y origen con costo pendiente.'}</span>
      ) : (
        <ul className="check-list lot-check-list">
          {items.map((lot) => (
            <li key={lot.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={chosen.includes(lot.id)}
                  onChange={(e) => {
                    const next = e.target.checked ? [...chosen, lot.id] : chosen.filter((id) => id !== lot.id)
                    onChange(next.join(','), items.filter((option) => next.includes(option.id)).reduce((total, option) => total + lotProfiles(option), 0))
                  }}
                />
                <span>
                  <strong>{lot.code}</strong> · {lot.reference.code} {lot.finish.description ?? lot.finish.code} · {lot.supplier?.name ?? 'sin proveedor'}
                  <span className="cell-sub">{lotContents(lot.totals)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 ? <span className="field-hint">{hint}</span> : null}
    </div>
  )
}

// Purchases and acquisition cost (ADMIN), entered as on the invoice: gross
// value without VAT, discount, VAT on the discounted base. Cost per profile =
// (base + VAT) ÷ profiles. Sale prices are built on these lines in «Precios
// de venta».
export function PurchasesAdmin() {
  const { request } = useSession()
  // List filters: any combination, or none.
  const [filters, setFilters] = useState({ supplierId: '', dateFrom: '', dateTo: '', catalog: EMPTY_CATALOG })
  const purchases = useLoad<PurchaseRow[]>(
    `/purchases${queryString({
      supplierId: filters.supplierId,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      familyId: filters.catalog.familyId,
      referenceId: filters.catalog.referenceId,
    })}`,
  )
  const activeFilters = [filters.supplierId, filters.dateFrom, filters.dateTo, filters.catalog.familyId, filters.catalog.referenceId].filter(Boolean).length
  // Inactive suppliers too, for the filter (older purchases); the form only offers active ones.
  const suppliers = useLoad<Supplier[]>('/suppliers')
  const activeSuppliers = (suppliers.data ?? []).filter((supplier) => supplier.active)
  const [editingId, setEditingId] = useState<string | null>(null)
  const detail = useLoad<PurchaseDetail>(editingId ? `/purchases/${encodeURIComponent(editingId)}` : null)
  const [form, setForm] = useState<{
    supplierId: string
    documentNumber: string
    documentDate: string
    lines: LineDraft[]
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useUnsavedWork(form ? 'Compra con cambios sin guardar' : null)

  const start = () => {
    setEditingId(null)
    setError(null)
    setForm({ supplierId: '', documentNumber: '', documentDate: todayIso(), lines: [emptyLine()] })
  }

  const edit = (purchase: PurchaseDetail) => {
    setForm({
      supplierId: purchase.supplierId,
      documentNumber: purchase.documentNumber,
      documentDate: purchase.documentDate.slice(0, 10),
      lines: purchase.lines.map((line) => ({
        key: line.id,
        catalog: { familyId: '', referenceId: line.referenceId, finishId: line.finishId },
        origin: line.origin,
        quantity: String(line.profiles || ''),
        // Drafts recorded with earlier rules must be re-entered without VAT.
        grossAmount: line.taxOnNet ? line.grossAmount : '',
        discountPercent: line.taxOnNet ? line.lineDiscountValue : '0',
        taxRatePercent: line.taxOnNet && line.taxRatePercent !== null ? String(Number(line.taxRatePercent)) : '19',
        lotIds: line.lots.map((lot) => lot.id).join(','),
        quantityFromLots: false,
      })),
    })
  }

  const save = async () => {
    if (!form) return
    setBusy(true)
    setError(null)
    try {
      const body = {
        supplierId: form.supplierId,
        documentNumber: form.documentNumber.trim(),
        documentDate: form.documentDate,
        lines: form.lines.map((line) => ({
          referenceId: line.catalog.referenceId,
          finishId: line.catalog.finishId,
          origin: line.origin,
          quantity: Number(line.quantity),
          grossAmount: dec(line.grossAmount),
          discountPercent: dec(line.discountPercent || '0'),
          taxRatePercent: dec(line.taxRatePercent),
          lotIds: line.lotIds ? line.lotIds.split(',') : [],
        })),
      }
      const { data } = await request<PurchaseDetail>(editingId ? `/purchases/${encodeURIComponent(editingId)}` : '/purchases', { method: editingId ? 'PATCH' : 'POST', body })
      setEditingId(data.id)
      setForm(null)
      purchases.reload()
      detail.reload()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (!editingId) return
    setBusy(true)
    setError(null)
    try {
      await request(`/purchases/${encodeURIComponent(editingId)}/confirm`, { method: 'POST' })
      detail.reload()
      purchases.reload()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  // Another material or origin: its lots no longer apply, nor a quantity taken from them.
  const clearLots = (line: LineDraft): Partial<LineDraft> => ({ lotIds: '', ...(line.quantityFromLots ? { quantity: '', quantityFromLots: false } : {}) })

  const setLine = (index: number, patch: Partial<LineDraft>) =>
    form && setForm({ ...form, lines: form.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) })

  const purchase = detail.data
  const legacy = purchase?.lines.some((line) => !line.taxOnNet && !line.grossIncludesTax) ?? false
  const taxIncluded = purchase?.lines.some((line) => line.grossIncludesTax) ?? false

  return (
    <div className="admin-section">
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!form ? (
        <section className="card">
          <div className="actions">
            <button type="button" className="button" onClick={start}>Nueva compra</button>
          </div>
          <FilterPanel activeCount={activeFilters} onClear={() => setFilters({ supplierId: '', dateFrom: '', dateTo: '', catalog: EMPTY_CATALOG })}>
            <Field label="Proveedor">
              <select value={filters.supplierId} onChange={(e) => setFilters({ ...filters, supplierId: e.target.value })}>
                <option value="">Todos</option>
                {(suppliers.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.active ? '' : ' (inactivo)'}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Fecha desde">
              <input type="date" value={filters.dateFrom} max={filters.dateTo || undefined} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} />
            </Field>
            <Field label="Fecha hasta">
              <input type="date" value={filters.dateTo} min={filters.dateFrom || undefined} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} />
            </Field>
            <CatalogSelectors mode="filter" showFinish={false} value={filters.catalog} onChange={(catalog) => setFilters({ ...filters, catalog })} />
          </FilterPanel>
          {purchases.error ? <Notice kind="error">{purchases.error}</Notice> : null}
          {purchases.data && purchases.data.length === 0 ? (
            <p className="field-hint">{activeFilters > 0 ? 'No hay compras con estos filtros.' : 'Todavía no hay compras registradas.'}</p>
          ) : null}
          <ul className="doc-list">
            {(purchases.data ?? []).map((row) => (
              <li key={row.id}>
                <button type="button" className="doc-row" onClick={() => { setForm(null); setEditingId(row.id) }}>
                  <span className="doc-main">
                    <strong>{row.documentNumber} · {row.supplier.name}</strong>
                    <small>{row.documentDate.slice(0, 10)} · {row.currency}</small>
                  </span>
                  <span className="doc-side">
                    <strong>{formatMoney(row.documentTotal, row.currency)}</strong>
                    <span className={`badge ${row.status === 'DRAFT' ? 'badge-warning' : ''}`}>{row.status === 'DRAFT' ? 'Borrador' : 'Confirmada'}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {purchase && !form ? (
        <section className="card">
          <h2 className="subtitle">{purchase.documentNumber} · {purchase.supplier.name}</h2>
          {legacy ? (
            <Notice kind="info">
              Compra registrada con la definición de costo anterior (neto, IVA descontable o no y gastos). Sus importes se
              conservan tal como se guardaron y no se usan para precios de venta.
            </Notice>
          ) : null}
          {taxIncluded ? (
            <Notice kind="info">
              Renglones registrados con la regla anterior: el valor bruto ya traía el IVA y el descuento se aplicó sobre ese
              valor. Se conservan tal como se guardaron.
            </Notice>
          ) : null}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Material</th><th>Origen</th><th className="num">Perfiles</th><th className="num">Valor bruto sin IVA</th>
                  <th className="num">Descuento</th><th className="num">Base después del descuento</th><th className="num">IVA de compra</th>
                  <th className="num">Total con IVA</th><th className="num">Costo por perfil (IVA incluido)</th><th>Lotes</th>
                </tr>
              </thead>
              <tbody>
                {purchase.lines.map((line) => (
                  <tr key={line.id}>
                    <td data-label="#">{line.lineNo}</td>
                    <td data-label="Material">{line.reference.code} · {line.finish.description ?? line.finish.code}</td>
                    <td data-label="Origen">{ORIGIN_LABEL[line.origin]}</td>
                    <td className="num" data-label="Perfiles">{line.profiles}</td>
                    <td className="num" data-label="Valor bruto sin IVA">
                      {line.taxOnNet ? formatMoney(line.grossAmount) : line.grossIncludesTax ? `${formatMoney(line.grossAmount)} (con IVA)` : '—'}
                    </td>
                    <td className="num" data-label="Descuento">
                      {line.taxOnNet || line.grossIncludesTax ? `${Number(line.lineDiscountValue)} % · ${formatMoney(line.lineDiscountAmount)}` : '—'}
                    </td>
                    <td className="num" data-label="Base después del descuento">{line.taxOnNet ? formatMoney(line.netAmount) : '—'}</td>
                    <td className="num" data-label="IVA de compra">
                      {line.taxOnNet ? `${Number(line.taxRatePercent ?? 0)} % · ${formatMoney(line.taxAmount)}` : line.grossIncludesTax ? 'Incluido en el bruto' : '—'}
                    </td>
                    <td className="num" data-label="Total con IVA">{formatMoney(line.costAmountCop)}</td>
                    <td className="num" data-label="Costo por perfil">{line.unitCostCop ? formatUnitCost(line.unitCostCop) : '—'}</td>
                    <td data-label="Lotes">{line.lots.map((lot) => lot.code).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {taxIncluded ? (
            // Saved with the previous rule: its totals keep their meaning.
            <p className="quote-totals">
              Valor bruto (IVA incluido) {formatMoney(purchase.grossTotal, purchase.currency)} · Descuentos {formatMoney(purchase.lineDiscountTotal, purchase.currency)} ·{' '}
              <strong>Costo total (IVA de compra incluido) {formatMoney(purchase.documentTotal, purchase.currency)}</strong>
            </p>
          ) : (
            <p className="quote-totals">
              Valor bruto sin IVA {formatMoney(purchase.grossTotal, purchase.currency)} · Descuentos {formatMoney(purchase.lineDiscountTotal, purchase.currency)} ·
              Base {formatMoney(purchase.netTotal, purchase.currency)} · IVA {formatMoney(purchase.taxTotal, purchase.currency)} ·{' '}
              <strong>Total con IVA {formatMoney(purchase.documentTotal, purchase.currency)}</strong>
            </p>
          )}
          {purchase.issues.length > 0 ? (
            <Notice kind="warning">
              Pendiente antes de confirmar:
              <ul>{purchase.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
            </Notice>
          ) : null}
          {purchase.status === 'DRAFT' ? (
            <div className="actions">
              <button type="button" className="button" disabled={busy || purchase.issues.length > 0} onClick={() => void confirm()}>Confirmar compra y costos</button>
              <button type="button" className="button button-secondary" onClick={() => edit(purchase)}>Editar borrador</button>
            </div>
          ) : (
            <p className="field-hint">Compra confirmada: sus importes quedan fijos. Crea sus precios en «Precios de venta».</p>
          )}
        </section>
      ) : null}

      {form ? (
        <section className="card">
          <h2 className="subtitle">{editingId ? 'Editar compra' : 'Nueva compra'}</h2>
          <p className="field-hint">Como en la factura: valor bruto sin IVA, el descuento sobre ese valor y el IVA sobre la base ya descontada.</p>
          <div className="form-grid">
            <Field label="Proveedor">
              <select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
                <option value="">Elige…</option>
                {activeSuppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Número de documento"><input value={form.documentNumber} onChange={(e) => setForm({ ...form, documentNumber: e.target.value })} /></Field>
            <Field label="Fecha"><input type="date" value={form.documentDate} onChange={(e) => setForm({ ...form, documentDate: e.target.value })} /></Field>
          </div>

          {form.lines.map((line, index) => {
            const amounts = preview(line)
            return (
              <fieldset key={line.key} className="card quote-line">
                <legend className="quote-line-title">Renglón {index + 1}</legend>
                <div className="form-grid">
                  <CatalogSelectors mode="form" value={line.catalog} onChange={(catalog) => setLine(index, { catalog, ...clearLots(line) })} />
                  <Field label="Origen">
                    <select value={line.origin} onChange={(e) => setLine(index, { origin: e.target.value as MaterialOrigin, ...clearLots(line) })}>
                      <option value="NATIONAL">Nacional</option>
                      <option value="CHINA">China</option>
                    </select>
                  </Field>
                  <LotPicker
                    line={line}
                    onChange={(lotIds, profiles) =>
                      setLine(index, profiles > 0 ? { lotIds, quantity: String(profiles), quantityFromLots: true } : { lotIds, ...(line.quantityFromLots ? { quantity: '', quantityFromLots: false } : {}) })
                    }
                  />
                  <Field
                    label="Cantidad de perfiles"
                    hint={line.quantityFromLots ? 'Tomada de los lotes seleccionados; corrígela si la factura dice otra cantidad.' : undefined}
                  >
                    <input type="number" inputMode="numeric" min={1} value={line.quantity} onChange={(e) => setLine(index, { quantity: e.target.value, quantityFromLots: false })} />
                  </Field>
                  <Field label="Valor bruto de compra — sin IVA" hint="Importe del renglón antes del descuento y sin el IVA.">
                    <input inputMode="decimal" value={line.grossAmount} onChange={(e) => setLine(index, { grossAmount: e.target.value })} />
                  </Field>
                  <Field label="Descuento (%)" hint="Sobre el valor bruto, antes del IVA.">
                    <input inputMode="decimal" value={line.discountPercent} onChange={(e) => setLine(index, { discountPercent: e.target.value })} />
                  </Field>
                  <Field label="IVA de compra (%)" hint="Sobre la base ya descontada. 0 si la compra no tiene IVA.">
                    <input inputMode="decimal" value={line.taxRatePercent} onChange={(e) => setLine(index, { taxRatePercent: e.target.value })} />
                  </Field>
                </div>
                <div className="quote-line-info">
                  {amounts ? (
                    <>
                      <span>Descuento: <strong>{formatMoney(amounts.discount)}</strong></span>
                      <span>Base sin IVA: <strong>{formatMoney(amounts.net)}</strong></span>
                      <span>IVA: <strong>{formatMoney(amounts.tax)}</strong></span>
                      <span>Total con IVA: <strong>{formatMoney(amounts.total)}</strong></span>
                      <span>Costo por perfil (IVA incluido): <strong>{formatUnitCost(amounts.unitCost.toFixed(6))}</strong></span>
                    </>
                  ) : (
                    <span className="field-hint">Escribe cantidad, valor bruto, descuento e IVA para ver el costo por perfil.</span>
                  )}
                  {form.lines.length > 1 ? (
                    <button type="button" className="text-button danger" onClick={() => setForm({ ...form, lines: form.lines.filter((_, i) => i !== index) })}>Quitar renglón</button>
                  ) : null}
                </div>
              </fieldset>
            )
          })}
          <button type="button" className="button button-secondary" onClick={() => setForm({ ...form, lines: [...form.lines, emptyLine()] })}>+ Renglón</button>

          <div className="actions">
            <button type="button" className="button" disabled={busy || !form.supplierId || !form.documentNumber.trim()} onClick={() => void save()}>
              {busy ? 'Guardando…' : 'Guardar borrador'}
            </button>
            <button type="button" className="text-button" onClick={() => setForm(null)}>Descartar cambios</button>
          </div>
        </section>
      ) : null}
    </div>
  )
}
