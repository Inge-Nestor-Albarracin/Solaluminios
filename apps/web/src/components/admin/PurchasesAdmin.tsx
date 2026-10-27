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
  grossIncludesTax: boolean
  grossAmount: string
  lineDiscountValue: string
  lineDiscountAmount: string
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
  quantity: '',
  grossAmount: '',
  discountPercent: '0',
  lotIds: '',
})

const dec = (value: string) => value.trim().replace(',', '.')
const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/

// Preview of the server's rule (the server recomputes with decimals on save):
// discount = gross × % / 100; cost = gross − discount; per profile = cost ÷ profiles.
function preview(line: LineDraft) {
  const quantity = Number(line.quantity)
  const gross = dec(line.grossAmount)
  const discount = dec(line.discountPercent || '0')
  if (!Number.isInteger(quantity) || quantity < 1 || !DECIMAL.test(gross) || !DECIMAL.test(discount)) return null
  const grossCents = Math.round(Number(gross) * 100)
  const discountCents = Math.round((grossCents * Number(discount)) / 100)
  const costCents = grossCents - discountCents
  return { discount: discountCents / 100, cost: costCents / 100, unitCost: costCents / 100 / quantity }
}

function LotPicker({ line, onChange }: { line: LineDraft; onChange: (lotIds: string) => void }) {
  const enc = encodeURIComponent
  const lots = useLoad<Page<LotOption>>(
    line.catalog.referenceId && line.catalog.finishId
      ? `/lots?referenceId=${enc(line.catalog.referenceId)}&finishId=${enc(line.catalog.finishId)}&origin=${line.origin}&costPending=true&pageSize=50`
      : null,
  )
  const chosen = line.lotIds ? line.lotIds.split(',') : []
  return (
    <Field label="Lotes que documenta (opcional)" hint="Lotes de ese material y origen con costo pendiente.">
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

// Purchases and acquisition cost (ADMIN). The supplier's gross value already
// includes the purchase VAT: cost per profile = (gross − discount) ÷ profiles.
// Sale prices are built on these lines in «Precios de venta».
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
        // A draft recorded with the earlier definition must be re-entered with the VAT-included value.
        grossAmount: line.grossIncludesTax ? line.grossAmount : '',
        discountPercent: line.grossIncludesTax ? line.lineDiscountValue : '0',
        lotIds: line.lots.map((lot) => lot.id).join(','),
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

  const setLine = (index: number, patch: Partial<LineDraft>) =>
    form && setForm({ ...form, lines: form.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) })

  const purchase = detail.data
  const legacy = purchase?.lines.some((line) => !line.grossIncludesTax) ?? false

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
          {legacy ? (
            <Notice kind="info">
              Compra registrada con la definición de costo anterior (neto, IVA descontable o no y gastos). Sus importes se
              conservan tal como se guardaron y no se usan para precios de venta.
            </Notice>
          ) : null}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Material</th><th>Origen</th><th className="num">Perfiles</th><th className="num">Valor bruto (IVA incluido)</th>
                  <th className="num">Descuento</th><th className="num">Costo después del descuento</th><th className="num">Costo por perfil (IVA de compra incluido)</th><th>Lotes</th>
                </tr>
              </thead>
              <tbody>
                {purchase.lines.map((line) => (
                  <tr key={line.id}>
                    <td data-label="#">{line.lineNo}</td>
                    <td data-label="Material">{line.reference.code} · {line.finish.description ?? line.finish.code}</td>
                    <td data-label="Origen">{ORIGIN_LABEL[line.origin]}</td>
                    <td className="num" data-label="Perfiles">{line.profiles}</td>
                    <td className="num" data-label="Valor bruto">{line.grossIncludesTax ? formatMoney(line.grossAmount) : '—'}</td>
                    <td className="num" data-label="Descuento">
                      {line.grossIncludesTax ? `${Number(line.lineDiscountValue)} % · ${formatMoney(line.lineDiscountAmount)}` : '—'}
                    </td>
                    <td className="num" data-label="Costo">{formatMoney(line.costAmountCop)}</td>
                    <td className="num" data-label="Costo por perfil">{line.unitCostCop ? formatUnitCost(line.unitCostCop) : '—'}</td>
                    <td data-label="Lotes">{line.lots.map((lot) => lot.code).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="quote-totals">
            Valor bruto {formatMoney(purchase.grossTotal, purchase.currency)} · Descuentos {formatMoney(purchase.lineDiscountTotal, purchase.currency)} ·{' '}
            <strong>Costo total (IVA de compra incluido) {formatMoney(purchase.netTotal, purchase.currency)}</strong>
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
            <p className="field-hint">Compra confirmada: sus importes quedan fijos. Crea sus precios en «Precios de venta».</p>
          )}
        </section>
      ) : null}

      {form ? (
        <section className="card">
          <h2 className="subtitle">{editingId ? 'Editar compra' : 'Nueva compra'}</h2>
          <p className="field-hint">El valor bruto de compra ya incluye el IVA de compra: no se suma ni se descuenta de nuevo.</p>
          <div className="form-grid">
            <Field label="Proveedor">
              <select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
                <option value="">Elige…</option>
                {(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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
                  <CatalogSelectors mode="form" value={line.catalog} onChange={(catalog) => setLine(index, { catalog, lotIds: '' })} />
                  <Field label="Origen">
                    <select value={line.origin} onChange={(e) => setLine(index, { origin: e.target.value as MaterialOrigin, lotIds: '' })}>
                      <option value="NATIONAL">Nacional</option>
                      <option value="CHINA">China</option>
                    </select>
                  </Field>
                  <Field label="Cantidad de perfiles">
                    <input type="number" inputMode="numeric" min={1} value={line.quantity} onChange={(e) => setLine(index, { quantity: e.target.value })} />
                  </Field>
                  <Field label="Valor bruto de compra — IVA incluido" hint="Importe antes del descuento, con el IVA de compra.">
                    <input inputMode="decimal" value={line.grossAmount} onChange={(e) => setLine(index, { grossAmount: e.target.value })} />
                  </Field>
                  <Field label="Descuento (%)">
                    <input inputMode="decimal" value={line.discountPercent} onChange={(e) => setLine(index, { discountPercent: e.target.value })} />
                  </Field>
                  <LotPicker line={line} onChange={(lotIds) => setLine(index, { lotIds })} />
                </div>
                <div className="quote-line-info">
                  {amounts ? (
                    <span>
                      Descuento {formatMoney(amounts.discount)} · Costo después del descuento {formatMoney(amounts.cost)} ·{' '}
                      <strong>Costo por perfil (IVA de compra incluido) {formatUnitCost(amounts.unitCost.toFixed(6))}</strong>
                    </span>
                  ) : null}
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
