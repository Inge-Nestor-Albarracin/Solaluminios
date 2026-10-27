import { useState } from 'react'
import { describeError } from '../../api/client'
import type { Page } from '../../api/types'
import { ORIGIN_LABEL, formatMoney, formatUnitCost, type MaterialOrigin, type Supplier } from '../../lib/commerce'
import { EMPTY_CATALOG, type CatalogValue } from '../../lib/forms'
import { todayIso } from '../../lib/format'
import { useLoad } from '../../lib/useLoad'
import { uuid } from '../../lib/uuid'
import { useUnsavedWork } from '../../pwa/workGuard'
import { useSession } from '../../session/session-context'
import { CatalogSelectors } from '../CatalogSelectors'
import { Field, Notice } from '../ui'

type DiscountType = 'NONE' | 'PERCENT' | 'AMOUNT'

interface PurchaseRow {
  id: string
  documentNumber: string
  documentDate: string
  currency: string
  status: 'DRAFT' | 'CONFIRMED'
  documentTotal: string
  supplier: { name: string }
}

interface PurchaseDetail extends PurchaseRow {
  supplierId: string
  exchangeRate: string | null
  exchangeRateDate: string | null
  exchangeRateSource: string | null
  globalDiscountType: DiscountType
  globalDiscountValue: string
  conditionalDiscountNote: string | null
  grossTotal: string
  lineDiscountTotal: string
  globalDiscountTotal: string
  netTotal: string
  taxTotal: string
  chargesTotal: string
  issues: string[]
  lines: {
    id: string
    lineNo: number
    referenceId: string
    finishId: string
    origin: MaterialOrigin
    unitName: string
    profilesPerUnit: string
    quantity: string
    unitPrice: string
    lineDiscountType: DiscountType
    lineDiscountValue: string
    taxRatePercent: string | null
    taxRecoverable: boolean | null
    netAmount: string
    globalDiscountAmount: string
    taxAmount: string
    chargesAmount: string
    costAmountCop: string
    profiles: number
    unitCostCop: string | null
    reference: { code: string }
    finish: { code: string; description: string | null }
    lots: { id: string; code: string }[]
  }[]
  charges: { description: string; amount: string }[]
}

interface LineDraft {
  key: string
  catalog: CatalogValue
  origin: MaterialOrigin
  unitName: string
  profilesPerUnit: string
  quantity: string
  unitPrice: string
  lineDiscountType: DiscountType
  lineDiscountValue: string
  taxRatePercent: string
  taxRecoverable: '' | 'true' | 'false'
  lotIds: string
}

interface LotOption {
  id: string
  code: string
  origin: MaterialOrigin
  unitCost: string | null
  supplier: { name: string } | null
  _count: { bundles: number }
}

const emptyLine = (): LineDraft => ({
  key: uuid(),
  catalog: EMPTY_CATALOG,
  origin: 'NATIONAL',
  unitName: 'perfil',
  profilesPerUnit: '1',
  quantity: '',
  unitPrice: '',
  lineDiscountType: 'NONE',
  lineDiscountValue: '0',
  taxRatePercent: '',
  taxRecoverable: '',
  lotIds: '',
})

const dec = (value: string) => value.trim().replace(',', '.')

function LotPicker({ line, onChange }: { line: LineDraft; onChange: (lotIds: string) => void }) {
  const enc = encodeURIComponent
  const lots = useLoad<Page<LotOption>>(
    line.catalog.referenceId && line.catalog.finishId
      ? `/lots?referenceId=${enc(line.catalog.referenceId)}&finishId=${enc(line.catalog.finishId)}&origin=${line.origin}&costPending=true&pageSize=50`
      : null,
  )
  const chosen = line.lotIds ? line.lotIds.split(',') : []
  return (
    <Field label="Lotes que documenta" hint="Lotes de ese material y origen con costo pendiente.">
      <select
        multiple
        value={chosen}
        onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value).join(','))}
      >
        {(lots.data?.items ?? []).map((lot) => (
          <option key={lot.id} value={lot.id}>
            {lot.code} · {lot.supplier?.name ?? 'sin proveedor'} · {lot._count.bundles} paquetes
          </option>
        ))}
      </select>
    </Field>
  )
}

// Purchases and acquisition cost (ADMIN). Separate from sales quotes. The
// API computes every amount with decimals and reports what blocks the
// confirmation (tax rate, recoverability, exchange rate, units…).
export function PurchasesAdmin() {
  const { request } = useSession()
  const purchases = useLoad<PurchaseRow[]>('/purchases')
  const suppliers = useLoad<Supplier[]>('/suppliers?active=true')
  const [editingId, setEditingId] = useState<string | null>(null)
  const detail = useLoad<PurchaseDetail>(editingId ? `/purchases/${encodeURIComponent(editingId)}` : null)
  const [form, setForm] = useState<{
    supplierId: string
    documentNumber: string
    documentDate: string
    currency: string
    exchangeRate: string
    exchangeRateDate: string
    exchangeRateSource: string
    globalDiscountType: DiscountType
    globalDiscountValue: string
    conditionalDiscountNote: string
    lines: LineDraft[]
    charges: { description: string; amount: string }[]
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useUnsavedWork(form ? 'Compra con cambios sin guardar' : null)

  const start = () => {
    setEditingId(null)
    setError(null)
    setForm({
      supplierId: '',
      documentNumber: '',
      documentDate: todayIso(),
      currency: 'COP',
      exchangeRate: '',
      exchangeRateDate: '',
      exchangeRateSource: '',
      globalDiscountType: 'NONE',
      globalDiscountValue: '0',
      conditionalDiscountNote: '',
      lines: [emptyLine()],
      charges: [],
    })
  }

  const edit = (purchase: PurchaseDetail) => {
    setForm({
      supplierId: purchase.supplierId,
      documentNumber: purchase.documentNumber,
      documentDate: purchase.documentDate.slice(0, 10),
      currency: purchase.currency,
      exchangeRate: purchase.exchangeRate ?? '',
      exchangeRateDate: purchase.exchangeRateDate?.slice(0, 10) ?? '',
      exchangeRateSource: purchase.exchangeRateSource ?? '',
      globalDiscountType: purchase.globalDiscountType,
      globalDiscountValue: purchase.globalDiscountValue,
      conditionalDiscountNote: purchase.conditionalDiscountNote ?? '',
      lines: purchase.lines.map((line) => ({
        key: line.id,
        catalog: { familyId: '', referenceId: line.referenceId, finishId: line.finishId },
        origin: line.origin,
        unitName: line.unitName,
        profilesPerUnit: line.profilesPerUnit,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineDiscountType: line.lineDiscountType,
        lineDiscountValue: line.lineDiscountValue,
        taxRatePercent: line.taxRatePercent ?? '',
        taxRecoverable: line.taxRecoverable === null ? '' : line.taxRecoverable ? 'true' : 'false',
        lotIds: line.lots.map((lot) => lot.id).join(','),
      })),
      charges: purchase.charges.map((charge) => ({ description: charge.description, amount: charge.amount })),
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
        currency: form.currency.trim().toUpperCase(),
        exchangeRate: form.currency === 'COP' || !form.exchangeRate ? null : dec(form.exchangeRate),
        exchangeRateDate: form.exchangeRateDate || null,
        exchangeRateSource: form.exchangeRateSource.trim() || null,
        globalDiscountType: form.globalDiscountType,
        globalDiscountValue: dec(form.globalDiscountValue || '0'),
        ...(form.conditionalDiscountNote.trim() ? { conditionalDiscountNote: form.conditionalDiscountNote.trim() } : {}),
        lines: form.lines.map((line) => ({
          referenceId: line.catalog.referenceId,
          finishId: line.catalog.finishId,
          origin: line.origin,
          unitName: line.unitName.trim(),
          profilesPerUnit: dec(line.profilesPerUnit),
          quantity: dec(line.quantity),
          unitPrice: dec(line.unitPrice),
          lineDiscountType: line.lineDiscountType,
          lineDiscountValue: dec(line.lineDiscountValue || '0'),
          taxRatePercent: line.taxRatePercent.trim() ? dec(line.taxRatePercent) : null,
          taxRecoverable: line.taxRecoverable === '' ? null : line.taxRecoverable === 'true',
          lotIds: line.lotIds ? line.lotIds.split(',') : [],
        })),
        charges: form.charges.filter((c) => c.description.trim()).map((c) => ({ description: c.description.trim(), amount: dec(c.amount || '0') })),
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

  const setLine = (index: number, patch: Partial<LineDraft>) =>
    form && setForm({ ...form, lines: form.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) })

  const purchase = detail.data

  return (
    <div className="admin-section">
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!form ? (
        <section className="card">
          <div className="actions">
            <button type="button" className="button" onClick={start}>Nueva compra</button>
          </div>
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
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>#</th><th>Material</th><th>Origen</th><th className="num">Neto</th><th className="num">Desc. general</th><th className="num">IVA</th><th className="num">Gastos</th><th className="num">Perfiles</th><th className="num">Costo/perfil COP</th><th>Lotes</th></tr>
              </thead>
              <tbody>
                {purchase.lines.map((line) => (
                  <tr key={line.id}>
                    <td data-label="#">{line.lineNo}</td>
                    <td data-label="Material">{line.reference.code} · {line.finish.description ?? line.finish.code} ({line.quantity} {line.unitName})</td>
                    <td data-label="Origen">{ORIGIN_LABEL[line.origin]}</td>
                    <td className="num" data-label="Neto">{formatMoney(line.netAmount, purchase.currency)}</td>
                    <td className="num" data-label="Desc. general">{formatMoney(line.globalDiscountAmount, purchase.currency)}</td>
                    <td className="num" data-label="IVA">{formatMoney(line.taxAmount, purchase.currency)}{line.taxRecoverable === false ? ' (al costo)' : ''}</td>
                    <td className="num" data-label="Gastos">{formatMoney(line.chargesAmount, purchase.currency)}</td>
                    <td className="num" data-label="Perfiles">{line.profiles}</td>
                    <td className="num" data-label="Costo/perfil">{line.unitCostCop ? formatUnitCost(line.unitCostCop) : '—'}</td>
                    <td data-label="Lotes">{line.lots.map((lot) => lot.code).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="quote-totals">
            Bruto {formatMoney(purchase.grossTotal, purchase.currency)} · Desc. renglón {formatMoney(purchase.lineDiscountTotal, purchase.currency)} · Desc. general{' '}
            {formatMoney(purchase.globalDiscountTotal, purchase.currency)} · Neto {formatMoney(purchase.netTotal, purchase.currency)} · IVA {formatMoney(purchase.taxTotal, purchase.currency)} · Gastos{' '}
            {formatMoney(purchase.chargesTotal, purchase.currency)} · <strong>Total {formatMoney(purchase.documentTotal, purchase.currency)}</strong>
          </p>
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
            <p className="field-hint">Compra confirmada: sus importes quedan fijos; los lotes asociados tienen el costo confirmado.</p>
          )}
        </section>
      ) : null}

      {form ? (
        <section className="card">
          <h2 className="subtitle">{editingId ? 'Editar compra' : 'Nueva compra'}</h2>
          <div className="form-grid">
            <Field label="Proveedor">
              <select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
                <option value="">Elige…</option>
                {(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Número de documento"><input value={form.documentNumber} onChange={(e) => setForm({ ...form, documentNumber: e.target.value })} /></Field>
            <Field label="Fecha"><input type="date" value={form.documentDate} onChange={(e) => setForm({ ...form, documentDate: e.target.value })} /></Field>
            <Field label="Moneda (ISO)"><input value={form.currency} maxLength={3} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></Field>
            {form.currency !== 'COP' ? (
              <>
                <Field label="Tasa aplicada a COP"><input inputMode="decimal" value={form.exchangeRate} onChange={(e) => setForm({ ...form, exchangeRate: e.target.value })} /></Field>
                <Field label="Fecha de la tasa"><input type="date" value={form.exchangeRateDate} onChange={(e) => setForm({ ...form, exchangeRateDate: e.target.value })} /></Field>
                <Field label="Fuente de la tasa"><input value={form.exchangeRateSource} onChange={(e) => setForm({ ...form, exchangeRateSource: e.target.value })} placeholder="p. ej. TRM del día, factura" /></Field>
              </>
            ) : null}
            <Field label="Descuento comercial general">
              <select value={form.globalDiscountType} onChange={(e) => setForm({ ...form, globalDiscountType: e.target.value as DiscountType })}>
                <option value="NONE">Sin descuento</option>
                <option value="PERCENT">Porcentaje</option>
                <option value="AMOUNT">Valor</option>
              </select>
            </Field>
            {form.globalDiscountType !== 'NONE' ? (
              <Field label={form.globalDiscountType === 'PERCENT' ? 'Descuento (%)' : 'Descuento (valor)'}>
                <input inputMode="decimal" value={form.globalDiscountValue} onChange={(e) => setForm({ ...form, globalDiscountValue: e.target.value })} />
              </Field>
            ) : null}
            <Field label="Descuento condicionado (nota)" hint="Se registra pero no reduce el costo sin una política contable.">
              <input value={form.conditionalDiscountNote} onChange={(e) => setForm({ ...form, conditionalDiscountNote: e.target.value })} />
            </Field>
          </div>

          {form.lines.map((line, index) => (
            <fieldset key={line.key} className="card quote-line">
              <legend className="quote-line-title">Renglón {index + 1}</legend>
              <div className="form-grid">
                <CatalogSelectors mode="form" value={line.catalog} onChange={(catalog) => setLine(index, { catalog, lotIds: '' })} />
                <Field label="Origen">
                  <select value={line.origin} onChange={(e) => setLine(index, { origin: e.target.value as MaterialOrigin, lotIds: '' })}>
                    <option value="NATIONAL">Nacional</option>
                    <option value="CHINA">China</option>
                  </select>
                </Field>
                <Field label="Unidad de compra"><input value={line.unitName} onChange={(e) => setLine(index, { unitName: e.target.value })} /></Field>
                <Field label="Perfiles por unidad" hint="1 si se compra por perfil."><input inputMode="decimal" value={line.profilesPerUnit} onChange={(e) => setLine(index, { profilesPerUnit: e.target.value })} /></Field>
                <Field label="Cantidad (unidades)"><input inputMode="decimal" value={line.quantity} onChange={(e) => setLine(index, { quantity: e.target.value })} /></Field>
                <Field label="Precio por unidad"><input inputMode="decimal" value={line.unitPrice} onChange={(e) => setLine(index, { unitPrice: e.target.value })} /></Field>
                <Field label="Descuento del renglón">
                  <select value={line.lineDiscountType} onChange={(e) => setLine(index, { lineDiscountType: e.target.value as DiscountType })}>
                    <option value="NONE">Sin descuento</option>
                    <option value="PERCENT">Porcentaje</option>
                    <option value="AMOUNT">Valor</option>
                  </select>
                </Field>
                {line.lineDiscountType !== 'NONE' ? (
                  <Field label={line.lineDiscountType === 'PERCENT' ? 'Descuento del renglón (%)' : 'Descuento del renglón (valor)'}><input inputMode="decimal" value={line.lineDiscountValue} onChange={(e) => setLine(index, { lineDiscountValue: e.target.value })} /></Field>
                ) : null}
                <Field label="IVA de compra (%)" hint="Explícito; puede ser 0."><input inputMode="decimal" value={line.taxRatePercent} onChange={(e) => setLine(index, { taxRatePercent: e.target.value })} /></Field>
                <Field label="¿IVA descontable?" hint="El IVA descontable no se suma al costo.">
                  <select value={line.taxRecoverable} onChange={(e) => setLine(index, { taxRecoverable: e.target.value as LineDraft['taxRecoverable'] })}>
                    <option value="">Sin definir</option>
                    <option value="true">Sí, descontable</option>
                    <option value="false">No: se suma al costo</option>
                  </select>
                </Field>
                <LotPicker line={line} onChange={(lotIds) => setLine(index, { lotIds })} />
              </div>
              {form.lines.length > 1 ? (
                <button type="button" className="text-button danger" onClick={() => setForm({ ...form, lines: form.lines.filter((_, i) => i !== index) })}>Quitar renglón</button>
              ) : null}
            </fieldset>
          ))}
          <button type="button" className="button button-secondary" onClick={() => setForm({ ...form, lines: [...form.lines, emptyLine()] })}>+ Renglón</button>

          <h3 className="subtitle">Gastos de adquisición atribuibles</h3>
          {form.charges.map((charge, index) => (
            <div key={index} className="form-grid">
              <Field label="Concepto"><input value={charge.description} onChange={(e) => setForm({ ...form, charges: form.charges.map((c, i) => (i === index ? { ...c, description: e.target.value } : c)) })} /></Field>
              <Field label="Valor (moneda del documento)"><input inputMode="decimal" value={charge.amount} onChange={(e) => setForm({ ...form, charges: form.charges.map((c, i) => (i === index ? { ...c, amount: e.target.value } : c)) })} /></Field>
            </div>
          ))}
          <button type="button" className="text-button" onClick={() => setForm({ ...form, charges: [...form.charges, { description: '', amount: '' }] })}>+ Gasto (flete, manejo…)</button>

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
