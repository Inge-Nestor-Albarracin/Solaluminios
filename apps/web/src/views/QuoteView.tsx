import { useRef, useState } from 'react'
import { ApiError, describeError } from '../api/client'
import { CatalogSelectors } from '../components/CatalogSelectors'
import { Field, Loading, Notice, PageHeader } from '../components/ui'
import {
  ORIGIN_LABEL,
  PRICING_HELP,
  PRICING_LABEL,
  formatMoney,
  formatUnitCost,
  type AvailabilityGroup,
  type Customer,
  type MaterialOrigin,
  type PricingMethod,
  type Quote,
  type Supplier,
} from '../lib/commerce'
import { EMPTY_CATALOG, type CatalogValue } from '../lib/forms'
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
  pricingMethod: PricingMethod
  pricingPercent: string
  unitPrice: string
  priceReason: string
  discountPercent: string
  taxRatePercent: string
}

// China preselected for new lines (agreed default), visible and editable.
const newLine = (): LineDraft => ({
  key: uuid(),
  catalog: EMPTY_CATALOG,
  origin: 'CHINA',
  supplierId: '',
  quantity: '',
  pricingMethod: 'MARKUP_ON_COST',
  pricingPercent: '',
  unitPrice: '',
  priceReason: '',
  discountPercent: '0',
  taxRatePercent: '',
})

const decimal = (value: string) => value.trim().replace(',', '.')
const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/

function LineEditor({
  line,
  index,
  suppliers,
  onChange,
  onRemove,
}: {
  line: LineDraft
  index: number
  suppliers: Supplier[]
  onChange: (line: LineDraft) => void
  onRemove: (() => void) | null
}) {
  const { referenceId, finishId } = line.catalog
  const enc = encodeURIComponent
  const availability = useLoad<AvailabilityGroup[]>(referenceId && finishId ? `/sales/availability?referenceId=${enc(referenceId)}&finishId=${enc(finishId)}` : null)
  const percent = decimal(line.pricingPercent)
  const suggestion = useLoad<{ available: boolean; message?: string; suggestedUnitPrice?: string; costBasis?: string; costLot?: string }>(
    referenceId && finishId && line.pricingMethod !== 'MANUAL' && DECIMAL.test(percent)
      ? `/sales/price-suggestion?referenceId=${enc(referenceId)}&finishId=${enc(finishId)}&origin=${line.origin}${line.supplierId ? `&supplierId=${enc(line.supplierId)}` : ''}&method=${line.pricingMethod}&percent=${enc(percent)}`
      : null,
  )
  const set = (patch: Partial<LineDraft>) => onChange({ ...line, ...patch })
  const forOrigin = (availability.data ?? []).filter((g) => g.origin === line.origin && (!line.supplierId || g.supplier?.id === line.supplierId))
  const available = forOrigin.reduce((total, g) => total + g.available, 0)
  const unknown = (availability.data ?? []).filter((g) => g.origin === 'UNKNOWN').reduce((total, g) => total + g.available, 0)
  const originSuppliers = suppliers.filter((s) => s.origins.includes(line.origin))

  return (
    <fieldset className="card quote-line">
      <legend className="quote-line-title">Renglón {index + 1}</legend>
      <div className="form-grid">
        <CatalogSelectors mode="form" value={line.catalog} onChange={(catalog) => set({ catalog })} />
        <Field label="Origen requerido" hint="China y Nacional son restricciones distintas aunque coincidan referencia y color.">
          <select value={line.origin} onChange={(e) => set({ origin: e.target.value as MaterialOrigin, supplierId: '' })}>
            <option value="CHINA">China</option>
            <option value="NATIONAL">Nacional</option>
          </select>
        </Field>
        <Field label="Proveedor exigido" hint="Solo si el cliente exige un proveedor concreto.">
          <select value={line.supplierId} onChange={(e) => set({ supplierId: e.target.value })}>
            <option value="">Cualquiera de origen {ORIGIN_LABEL[line.origin]}</option>
            {originSuppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Perfiles">
          <input type="number" inputMode="numeric" min={1} value={line.quantity} onChange={(e) => set({ quantity: e.target.value })} />
        </Field>
        <Field label="Precio" hint={PRICING_HELP[line.pricingMethod]}>
          <select value={line.pricingMethod} onChange={(e) => set({ pricingMethod: e.target.value as PricingMethod })}>
            {(Object.keys(PRICING_LABEL) as PricingMethod[]).map((method) => (
              <option key={method} value={method}>{PRICING_LABEL[method]}</option>
            ))}
          </select>
        </Field>
        {line.pricingMethod === 'MANUAL' ? (
          <>
            <Field label="Precio unitario sin IVA (COP)">
              <input inputMode="decimal" value={line.unitPrice} onChange={(e) => set({ unitPrice: e.target.value })} />
            </Field>
            <Field label="Motivo del precio manual">
              <input value={line.priceReason} maxLength={300} onChange={(e) => set({ priceReason: e.target.value })} />
            </Field>
          </>
        ) : (
          <Field label={line.pricingMethod === 'MARKUP_ON_COST' ? 'Recargo sobre costo (%)' : 'Margen bruto sobre venta (%)'}>
            <input inputMode="decimal" value={line.pricingPercent} onChange={(e) => set({ pricingPercent: e.target.value })} placeholder="p. ej. 30" />
          </Field>
        )}
        <Field label="Descuento (%)">
          <input inputMode="decimal" value={line.discountPercent} onChange={(e) => set({ discountPercent: e.target.value })} />
        </Field>
        <Field label="IVA de venta (%)" hint="Tarifa explícita del renglón (puede ser 0).">
          <input inputMode="decimal" value={line.taxRatePercent} onChange={(e) => set({ taxRatePercent: e.target.value })} placeholder="p. ej. 19" />
        </Field>
      </div>
      <div className="quote-line-info">
        {availability.data ? (
          <span>
            Disponible {ORIGIN_LABEL[line.origin]}{line.supplierId ? ' de ese proveedor' : ''}: <strong>{available}</strong> perfiles
            {unknown > 0 ? ` · ${unknown} más de origen desconocido (no se usan sin clasificar)` : ''}
          </span>
        ) : null}
        {suggestion.data?.available ? (
          <span>
            Precio sugerido: <strong>{formatMoney(suggestion.data.suggestedUnitPrice)}</strong> por perfil (último costo confirmado {formatUnitCost(suggestion.data.costBasis)}, lote {suggestion.data.costLot}).
          </span>
        ) : suggestion.data ? (
          <span className="field-error">{suggestion.data.message}</span>
        ) : null}
        {suggestion.error ? <span className="field-error">{suggestion.error}</span> : null}
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
      key={existing.data ? `${existing.data.id}:${existing.data.status}:${existing.data.total}:${existing.data.lines.length}` : 'new'}
      id={id}
      quote={existing.data}
      reload={existing.reload}
      navigate={navigate}
    />
  )
}

function QuoteEditor({ id, quote, reload, navigate }: { id?: string; quote: Quote | null; reload: () => void; navigate: Navigate }) {
  const { request } = useSession()
  const suppliers = useLoad<Supplier[]>('/suppliers?active=true')
  const [search, setSearch] = useState('')
  const customers = useLoad<Customer[]>(`/customers${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''}`)
  const [customerId, setCustomerId] = useState(quote?.customerId ?? '')
  const [newCustomer, setNewCustomer] = useState<{ name: string; taxId: string } | null>(null)
  const [validUntil, setValidUntil] = useState(quote?.validUntil?.slice(0, 10) ?? '')
  const [notes, setNotes] = useState(quote?.notes ?? '')
  const [lines, setLines] = useState<LineDraft[]>(() =>
    quote
      ? quote.lines.map((line) => ({
          key: line.id,
          catalog: { familyId: '', referenceId: line.referenceId, finishId: line.finishId },
          origin: line.origin,
          supplierId: line.supplierId ?? '',
          quantity: String(line.quantity),
          pricingMethod: line.pricingMethod,
          pricingPercent: line.pricingPercent ?? '',
          unitPrice: line.pricingMethod === 'MANUAL' ? line.unitPrice : '',
          priceReason: line.priceReason ?? '',
          discountPercent: line.discountPercent,
          taxRatePercent: line.taxRatePercent,
        }))
      : [newLine()],
  )
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const convertKey = useRef<string | null>(null)

  useUnsavedWork(dirty ? 'Cotización con cambios sin guardar' : null)

  const editable = !id || quote?.status === 'DRAFT'
  const update = (index: number, line: LineDraft) => {
    setDirty(true)
    setLines((current) => current.map((item, i) => (i === index ? line : item)))
  }

  const createCustomer = async () => {
    if (!newCustomer?.name.trim()) return
    try {
      const { data } = await request<Customer>('/customers', { method: 'POST', body: { name: newCustomer.name.trim(), ...(newCustomer.taxId.trim() ? { taxId: newCustomer.taxId.trim() } : {}) } })
      setCustomerId(data.id)
      setNewCustomer(null)
      customers.reload()
    } catch (err) {
      setError(describeError(err))
    }
  }

  const payload = () => ({
    customerId,
    ...(validUntil ? { validUntil } : {}),
    ...(notes.trim() ? { notes: notes.trim() } : {}),
    lines: lines.map((line) => ({
      referenceId: line.catalog.referenceId,
      finishId: line.catalog.finishId,
      origin: line.origin,
      ...(line.supplierId ? { supplierId: line.supplierId } : {}),
      quantity: Number(line.quantity),
      pricingMethod: line.pricingMethod,
      ...(line.pricingMethod === 'MANUAL'
        ? { unitPrice: decimal(line.unitPrice), priceReason: line.priceReason.trim() }
        : { pricingPercent: decimal(line.pricingPercent) }),
      discountPercent: decimal(line.discountPercent || '0'),
      taxRatePercent: decimal(line.taxRatePercent),
    })),
  })

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const { data } = await request<Quote>(id ? `/quotes/${encodeURIComponent(id)}` : '/quotes', { method: id ? 'PATCH' : 'POST', body: payload() })
      setDirty(false)
      if (!id) navigate({ name: 'quote', id: data.id })
      else reload()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const convert = async () => {
    if (!id) return
    setBusy(true)
    setError(null)
    convertKey.current ??= uuid()
    try {
      const { data } = await request<{ id: string }>(`/quotes/${encodeURIComponent(id)}/convert`, { method: 'POST', body: { operationKey: convertKey.current } })
      navigate({ name: 'order', id: data.id })
    } catch (err) {
      // Lost answer: keep the key; the retry returns the same order.
      if (!(err instanceof ApiError && (err.status === 0 || err.status >= 500))) convertKey.current = null
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (!id) return
    try {
      await request(`/quotes/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
      reload()
    } catch (err) {
      setError(describeError(err))
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Ventas · Cotización"
        title={quote ? quote.number : 'Nueva cotización'}
        description="Guardar una cotización no reserva ni descuenta inventario. Los precios se calculan en el servidor y se conservan con sus condiciones."
        actions={
          <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'sales' })}>
            Volver a ventas
          </button>
        }
      />
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
        <div className="form-grid">
          <Field label="Buscar cliente">
            <input value={search} disabled={!editable} onChange={(e) => setSearch(e.target.value)} placeholder="Nombre o NIT" />
          </Field>
          <Field label="Cliente">
            <select value={customerId} disabled={!editable} onChange={(e) => { setCustomerId(e.target.value); setDirty(true) }}>
              <option value="">Elige…</option>
              {quote && !customers.data?.some((c) => c.id === quote.customerId) ? <option value={quote.customerId}>{quote.customerName}</option> : null}
              {(customers.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.taxId ? ` · ${c.taxId}` : ''}</option>
              ))}
            </select>
          </Field>
          <Field label="Válida hasta">
            <input type="date" value={validUntil} disabled={!editable} onChange={(e) => { setValidUntil(e.target.value); setDirty(true) }} />
          </Field>
          <Field label="Notas">
            <input value={notes} disabled={!editable} maxLength={1000} onChange={(e) => { setNotes(e.target.value); setDirty(true) }} />
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
              onChange={(next) => update(index, next)}
              onRemove={lines.length > 1 ? () => { setDirty(true); setLines((current) => current.filter((_, i) => i !== index)) } : null}
            />
          ))}
          <button type="button" className="button button-secondary" onClick={() => { setDirty(true); setLines((current) => [...current, newLine()]) }}>
            + Agregar renglón
          </button>
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
                      {PRICING_LABEL[line.pricingMethod]}
                      {line.pricingPercent ? ` ${Number(line.pricingPercent)} %` : ''}
                      {line.costBasis ? <span className="cell-sub"> costo base {formatUnitCost(line.costBasis)}</span> : null}
                    </td>
                    <td className="num" data-label="Unitario">{formatMoney(line.unitPrice)}</td>
                    <td className="num" data-label="Desc.">{formatMoney(line.discountAmount)}</td>
                    <td className="num" data-label="IVA">{formatMoney(line.taxAmount)}</td>
                    <td className="num" data-label="Total">{formatMoney(line.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="quote-totals">
            Subtotal {formatMoney(quote.subtotal)} · Descuentos {formatMoney(quote.discountTotal)} · IVA {formatMoney(quote.taxTotal)} · <strong>Total {formatMoney(quote.total)}</strong>
          </p>
        </section>
      ) : null}

      {error ? <Notice kind="error">{error}</Notice> : null}
      {editable ? (
        <div className="actions">
          <button type="button" className="button" disabled={busy || !customerId} onClick={() => void save()}>
            {busy ? 'Guardando…' : id ? 'Guardar cambios' : 'Guardar cotización'}
          </button>
          {id && quote?.status === 'DRAFT' ? (
            <>
              <button type="button" className="button button-secondary" disabled={busy || dirty} title={dirty ? 'Guarda los cambios antes de convertir' : undefined} onClick={() => void convert()}>
                Convertir en orden de venta
              </button>
              <button type="button" className="text-button danger" disabled={busy} onClick={() => void cancel()}>Cancelar cotización</button>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
