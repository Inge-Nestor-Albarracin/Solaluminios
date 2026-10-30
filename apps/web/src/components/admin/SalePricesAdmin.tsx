import { useState, type FormEvent } from 'react'
import { ORIGIN_LABEL, formatMoney, formatUnitCost, type MaterialOrigin } from '../../lib/commerce'
import { useLoad } from '../../lib/useLoad'
import { useMutation } from '../../lib/useMutation'
import { useUnsavedWork } from '../../pwa/workGuard'
import { useSession } from '../../session/session-context'
import { Field, Notice } from '../ui'
import type { PurchaseDetail } from './PurchasesAdmin'

interface PurchaseRow {
  id: string
  documentNumber: string
  documentDate: string
  status: 'DRAFT' | 'CONFIRMED'
  supplier: { name: string }
}

interface SalePrice {
  id: string
  origin: MaterialOrigin
  unitCost: string
  markupPercent: string
  unitPrice: string
  enabled: boolean
  createdAt: string
  purchaseLine: {
    id: string
    lineNo: number
    reference: { code: string; description: string | null }
    finish: { code: string; description: string | null }
    purchase: { id: string; documentNumber: string; documentDate: string; supplier: { name: string } }
  }
}

const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/
// Sales VAT shown as an example only; sellers can change it on each line.
const SALES_VAT = 19

// Same rounding as the server: gain = cost × % / 100; price = cost + gain
// (cents); sales VAT on the price. Preview only: the server computes it.
function preview(unitCost: string, percent: string) {
  if (!DECIMAL.test(percent)) return null
  const cost = Number(unitCost)
  const gain = (cost * Number(percent)) / 100
  const price = Math.round((cost + gain) * 100) / 100
  const vat = Math.round(price * SALES_VAT) / 100
  return { gain: Math.round(gain * 100) / 100, price, vat, withVat: Math.round((price + vat) * 100) / 100 }
}

// Sale prices (ADMIN): each one is built on ONE line of ONE confirmed
// purchase. The administrator enables the price that sales receive for a
// reference, finish and origin; other prices keep their purchase and values.
export function SalePricesAdmin() {
  const { request } = useSession()
  const mutation = useMutation()
  const purchases = useLoad<PurchaseRow[]>('/purchases')
  const prices = useLoad<SalePrice[]>('/sale-prices')
  const [purchaseId, setPurchaseId] = useState('')
  const purchase = useLoad<PurchaseDetail>(purchaseId ? `/purchases/${encodeURIComponent(purchaseId)}` : null)
  const [lineId, setLineId] = useState('')
  const [percent, setPercent] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [message, setMessage] = useState<string | null>(null)

  useUnsavedWork(percent.trim() ? 'Precio de venta sin guardar' : null)

  const confirmed = (purchases.data ?? []).filter((p) => p.status === 'CONFIRMED')
  const lines = (purchase.data?.id === purchaseId ? purchase.data.lines : []).filter((line) => (line.taxOnNet || line.grossIncludesTax) && line.unitCostCop)
  const line = lines.find((l) => l.id === lineId) ?? null
  const markup = percent.trim().replace(',', '.')
  const amounts = line?.unitCostCop ? preview(line.unitCostCop, markup) : null

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!line) return
    setMessage(null)
    const ok = await mutation.run(() => request('/sale-prices', { method: 'POST', body: { purchaseId, purchaseLineId: line.id, markupPercent: markup, enabled } }))
    if (ok) {
      setMessage(enabled ? 'Precio guardado y habilitado para ventas.' : 'Precio guardado (sin habilitar).')
      setPercent('')
      prices.reload()
    }
  }

  const toggle = (price: SalePrice) =>
    mutation.run(async () => {
      await request(`/sale-prices/${encodeURIComponent(price.id)}/${price.enabled ? 'disable' : 'enable'}`, { method: 'POST' })
      prices.reload()
    })

  return (
    <div className="admin-section">
      {mutation.error ? <Notice kind="error">{mutation.error}</Notice> : null}
      {message ? <Notice kind="success">{message}</Notice> : null}

      <section className="card">
        <h2 className="subtitle">Nuevo precio de venta</h2>
        <p className="field-hint">
          Elige la compra y el renglón: el costo por perfil (IVA de compra incluido) sale de ese renglón. Precio de venta sin IVA =
          costo + ganancia sobre el costo. El IVA de venta se añade en la cotización.
        </p>
        <form className="form-grid" onSubmit={(e) => void save(e)}>
          <Field label="Compra">
            <select value={purchaseId} onChange={(e) => { setPurchaseId(e.target.value); setLineId('') }}>
              <option value="">Elige una compra confirmada…</option>
              {confirmed.map((p) => (
                <option key={p.id} value={p.id}>{p.documentNumber} · {p.supplier.name} · {p.documentDate.slice(0, 10)}</option>
              ))}
            </select>
          </Field>
          <Field label="Perfil de la compra">
            <select value={lineId} disabled={!purchaseId} onChange={(e) => setLineId(e.target.value)}>
              <option value="">{purchaseId && purchase.data && lines.length === 0 ? 'Sin renglones con costo por perfil' : 'Elige el renglón…'}</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.lineNo}. {l.reference.code} · {l.finish.description ?? l.finish.code} · {ORIGIN_LABEL[l.origin]}
                </option>
              ))}
            </select>
          </Field>
          {line ? (
            <>
              <Field label="Proveedor"><input readOnly value={purchase.data?.supplier.name ?? ''} /></Field>
              <Field label="Referencia y acabado"><input readOnly value={`${line.reference.code} · ${line.finish.description ?? line.finish.code}`} /></Field>
              <Field label="Origen"><input readOnly value={ORIGIN_LABEL[line.origin]} /></Field>
              <Field label="Costo de compra por perfil — IVA de compra incluido"><input readOnly value={formatUnitCost(line.unitCostCop)} /></Field>
              <Field label="Ganancia sobre el costo (%)">
                <input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="p. ej. 30" />
              </Field>
              <label className="check check-option">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Habilitar para ventas (reemplaza el precio
                habilitado de este perfil y origen)
              </label>
            </>
          ) : null}
          {amounts ? (
            <p className="quote-totals field-wide">
              Ganancia por perfil {formatMoney(amounts.gain)} · <strong>Precio de venta sin IVA (antes del IVA de venta) {formatMoney(amounts.price)}</strong>
              {' · '}IVA de venta {SALES_VAT} % {formatMoney(amounts.vat)} · Con IVA {formatMoney(amounts.withVat)}
            </p>
          ) : null}
          <div className="actions">
            <button type="submit" className="button" disabled={mutation.pending || !line || !DECIMAL.test(markup)}>
              {mutation.pending ? 'Guardando…' : 'Guardar precio'}
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2 className="subtitle">Precios de venta</h2>
        <p className="field-hint">Ventas recibe solo el precio habilitado de cada perfil y origen. Los demás se conservan con su compra.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Perfil</th><th>Origen</th><th>Compra</th><th className="num">Costo por perfil (IVA incl.)</th><th className="num">Ganancia</th>
                <th className="num">Precio sin IVA</th><th>Estado</th><th />
              </tr>
            </thead>
            <tbody>
              {(prices.data ?? []).map((price) => (
                <tr key={price.id}>
                  <td data-label="Perfil">{price.purchaseLine.reference.code} · {price.purchaseLine.finish.description ?? price.purchaseLine.finish.code}</td>
                  <td data-label="Origen">{ORIGIN_LABEL[price.origin]}</td>
                  <td data-label="Compra">{price.purchaseLine.purchase.documentNumber} · {price.purchaseLine.purchase.supplier.name} (renglón {price.purchaseLine.lineNo})</td>
                  <td className="num" data-label="Costo">{formatUnitCost(price.unitCost)}</td>
                  <td className="num" data-label="Ganancia">{Number(price.markupPercent)} %</td>
                  <td className="num" data-label="Precio sin IVA">{formatMoney(price.unitPrice)}</td>
                  <td data-label="Estado">
                    <span className={`badge ${price.enabled ? '' : 'badge-muted'}`}>{price.enabled ? 'Habilitado' : 'No habilitado'}</span>
                  </td>
                  <td>
                    <button type="button" className="text-button" disabled={mutation.pending} onClick={() => void toggle(price)}>
                      {price.enabled ? 'Deshabilitar' : 'Habilitar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
