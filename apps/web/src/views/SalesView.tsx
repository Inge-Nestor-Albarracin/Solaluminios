import { useState } from 'react'
import type { Page } from '../api/types'
import { Empty, Field, Loading, Notice, PageHeader, Pagination } from '../components/ui'
import type { AdminUser } from '../lib/admin'
import { ORDER_STATUS_LABEL, PAYMENT_STATUS_LABEL, formatMoney, type OrderStatus, type PaymentStatus } from '../lib/commerce'
import { formatDateTime } from '../lib/format'
import { useLoad } from '../lib/useLoad'
import { useSession } from '../session/session-context'
import type { Navigate } from './navigation'

interface QuoteRow {
  id: string
  number: string
  customerName: string
  status: 'DRAFT' | 'CONVERTED' | 'CANCELLED'
  total: string
  createdAt: string
  order: { id: string; number: string } | null
  // ADMIN only (the API omits it for other roles).
  createdBy?: { name: string }
  _count: { lines: number }
}

interface OrderRow {
  id: string
  number: string
  customerName: string
  status: OrderStatus
  total: string
  createdAt: string
  paymentStatus: PaymentStatus | null
  // ADMIN only (the API omits them for other roles): the seller (owner of
  // the order) and who converted the quote.
  createdBy?: { id: string; name: string }
  convertedBy?: { id: string; name: string } | null
  _count: { lines: number; dispatches: number }
}

// Sales of one seller for commissions; base = before VAT, after discounts.
interface SummaryBucket {
  orders: number
  base: string
  total: string
}
interface SellerSummary {
  seller: { id: string; name: string }
  all: SummaryBucket
  paid: SummaryBucket
  pending: SummaryBucket
  cash: SummaryBucket
}

interface OrderFilters {
  sellerId: string
  dateFrom: string
  dateTo: string
  payment: '' | 'PAID' | 'PENDING' | 'NONE'
  status: '' | OrderStatus
}

const NO_FILTERS: OrderFilters = { sellerId: '', dateFrom: '', dateTo: '', payment: '', status: '' }

const filterQuery = (filters: OrderFilters) =>
  Object.entries(filters)
    .filter(([, value]) => value)
    .map(([key, value]) => `&${key}=${encodeURIComponent(value)}`)
    .join('')

// Money of a summary cell: base before VAT (commission base) and total.
function Amount({ bucket }: { bucket: SummaryBucket }) {
  if (bucket.orders === 0) return <span className="cell-sub">—</span>
  return (
    <>
      <strong>{formatMoney(bucket.base)}</strong>
      <span className="cell-sub">
        {' '}con IVA {formatMoney(bucket.total)} · {bucket.orders} {bucket.orders === 1 ? 'orden' : 'órdenes'}
      </span>
    </>
  )
}

const QUOTE_STATUS = { DRAFT: 'Borrador', CONVERTED: 'Convertida en orden', CANCELLED: 'Cancelada' } as const

// Sales: quotes (no stock effect) and orders (reservations and dispatches).
// SALES sees only its own documents; ADMIN all (enforced by the API).
export function SalesView({ navigate, initialTab = 'quotes' }: { navigate: Navigate; initialTab?: 'quotes' | 'orders' }) {
  const { user } = useSession()
  const isAdmin = user?.role === 'ADMIN'
  const [tab, setTab] = useState<'quotes' | 'orders'>(initialTab)
  const [page, setPage] = useState(1)
  // ADMIN: who sold what and whether it is paid (commissions).
  const [filters, setFilters] = useState<OrderFilters>(NO_FILTERS)
  const query = isAdmin ? filterQuery(filters) : ''
  const quotes = useLoad<Page<QuoteRow>>(tab === 'quotes' ? `/quotes?page=${page}&pageSize=20` : null)
  const orders = useLoad<Page<OrderRow>>(tab === 'orders' ? `/sales-orders?page=${page}&pageSize=20${query}` : null)
  const summary = useLoad<SellerSummary[]>(tab === 'orders' && isAdmin ? `/sales-orders/summary?${query.slice(1)}` : null)
  const users = useLoad<AdminUser[]>(tab === 'orders' && isAdmin ? '/users' : null)
  const sellers = (users.data ?? []).filter((u) => u.role === 'SALES' || u.role === 'ADMIN').sort((a, b) => a.name.localeCompare(b.name))
  const current = tab === 'quotes' ? quotes : orders
  const setFilter = (patch: Partial<OrderFilters>) => {
    setFilters((value) => ({ ...value, ...patch }))
    setPage(1)
  }

  return (
    <>
      <PageHeader
        eyebrow="Ventas"
        title="Cotizaciones y órdenes"
        description="Una cotización no reserva inventario. Al confirmar una orden se reserva el material; las entregas se hacen con despachos."
        actions={
          <button type="button" className="button" onClick={() => navigate({ name: 'quote' })}>
            Nueva cotización
          </button>
        }
      />
      <div className="tabs" role="tablist">
        {(['quotes', 'orders'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'tab active' : 'tab'}
            onClick={() => {
              setTab(id)
              setPage(1)
            }}
          >
            {id === 'quotes' ? 'Cotizaciones' : 'Órdenes de venta'}
          </button>
        ))}
      </div>
      {tab === 'orders' && isAdmin ? (
        <section className="card">
          <h2 className="subtitle">Ventas por vendedor</h2>
          <div className="filters">
            <Field label="Vendedor">
              <select value={filters.sellerId} onChange={(e) => setFilter({ sellerId: e.target.value })}>
                <option value="">Todos</option>
                {sellers.map((seller) => (
                  <option key={seller.id} value={seller.id}>{seller.name}{seller.active ? '' : ' (inactivo)'}</option>
                ))}
              </select>
            </Field>
            <Field label="Desde">
              <input type="date" value={filters.dateFrom} onChange={(e) => setFilter({ dateFrom: e.target.value })} />
            </Field>
            <Field label="Hasta">
              <input type="date" value={filters.dateTo} onChange={(e) => setFilter({ dateTo: e.target.value })} />
            </Field>
            <Field label="Pago">
              <select value={filters.payment} onChange={(e) => setFilter({ payment: e.target.value as OrderFilters['payment'] })}>
                <option value="">Todos</option>
                <option value="PAID">Pagada</option>
                <option value="PENDING">Pago pendiente</option>
                <option value="NONE">Contado (sin seguimiento)</option>
              </select>
            </Field>
            <Field label="Estado">
              <select value={filters.status} onChange={(e) => setFilter({ status: e.target.value as OrderFilters['status'] })}>
                <option value="">Todos (el resumen no cuenta canceladas)</option>
                {(Object.keys(ORDER_STATUS_LABEL) as OrderStatus[]).map((status) => (
                  <option key={status} value={status}>{ORDER_STATUS_LABEL[status]}</option>
                ))}
              </select>
            </Field>
          </div>
          {Object.values(filters).some(Boolean) ? (
            <button type="button" className="text-button" onClick={() => { setFilters(NO_FILTERS); setPage(1) }}>Quitar filtros</button>
          ) : null}
          {summary.error ? <Notice kind="error">{summary.error}</Notice> : null}
          {summary.data ? (
            summary.data.length === 0 ? (
              <p className="field-hint">Sin ventas con estos filtros.</p>
            ) : (
              <div className="table-wrap">
                <table className="seller-summary">
                  <thead>
                    <tr>
                      <th>Vendedor</th><th className="num">Vendido</th><th className="num">Pagado</th><th className="num">Pago pendiente</th><th className="num">Contado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.data.map((row) => (
                      <tr key={row.seller.id}>
                        <td data-label="Vendedor">
                          <button type="button" className="link" onClick={() => setFilter({ sellerId: row.seller.id })}>{row.seller.name}</button>
                        </td>
                        <td className="num" data-label="Vendido"><Amount bucket={row.all} /></td>
                        <td className="num" data-label="Pagado"><Amount bucket={row.paid} /></td>
                        <td className="num" data-label="Pago pendiente"><Amount bucket={row.pending} /></td>
                        <td className="num" data-label="Contado"><Amount bucket={row.cash} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : null}
          <p className="field-hint">
            Valores sin IVA después de descuentos (base de comisión) y, debajo, con IVA. El vendedor es quien hizo la cotización. Pagada / pendiente aplica a
            abono y crédito; las ventas de contado no llevan seguimiento de pago.
          </p>
        </section>
      ) : null}
      {current.error ? <Notice kind="error">{current.error}</Notice> : null}
      {current.loading && !current.data ? <Loading /> : null}
      {tab === 'quotes' && quotes.data ? (
        quotes.data.items.length === 0 ? (
          <Empty title="Sin cotizaciones">Crea la primera con «Nueva cotización».</Empty>
        ) : (
          <ul className="doc-list">
            {quotes.data.items.map((quote) => (
              <li key={quote.id}>
                <button type="button" className="doc-row" onClick={() => navigate({ name: 'quote', id: quote.id })}>
                  <span className="doc-main">
                    <strong>{quote.number}</strong>
                    <small>
                      {quote.customerName} · {quote._count.lines} renglones · {formatDateTime(quote.createdAt)}
                      {quote.createdBy ? ` · creada por ${quote.createdBy.name}` : ''}
                    </small>
                  </span>
                  <span className="doc-side">
                    <strong>{formatMoney(quote.total)}</strong>
                    <span className={`badge ${quote.status === 'DRAFT' ? '' : 'badge-muted'}`}>{quote.order ? `Orden ${quote.order.number}` : QUOTE_STATUS[quote.status]}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {tab === 'orders' && orders.data ? (
        orders.data.items.length === 0 ? (
          <Empty title="Sin órdenes">{query ? 'Ninguna orden cumple estos filtros.' : 'Las órdenes se crean al convertir una cotización.'}</Empty>
        ) : (
          <ul className="doc-list">
            {orders.data.items.map((order) => (
              <li key={order.id}>
                <button type="button" className="doc-row" onClick={() => navigate({ name: 'order', id: order.id })}>
                  <span className="doc-main">
                    <strong>{order.number}</strong>
                    <small>
                      {order.customerName} · {order._count.dispatches} despachos · {formatDateTime(order.createdAt)}
                      {order.createdBy ? (
                        <>
                          {' · '}vendedor <strong>{order.createdBy.name}</strong>
                          {order.convertedBy && order.convertedBy.id !== order.createdBy.id ? ` · convertida por ${order.convertedBy.name}` : ''}
                        </>
                      ) : null}
                    </small>
                  </span>
                  <span className="doc-side">
                    <strong>{formatMoney(order.total)}</strong>
                    <span className={`badge status-${order.status.toLowerCase()}`}>{ORDER_STATUS_LABEL[order.status]}</span>
                    {order.paymentStatus ? (
                      <span className={`badge ${order.paymentStatus === 'PAID' ? 'badge-paid' : 'badge-warning'}`}>{PAYMENT_STATUS_LABEL[order.paymentStatus]}</span>
                    ) : isAdmin ? (
                      <span className="badge badge-muted">Contado</span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {current.data && current.data.totalPages > 1 ? (
        <Pagination page={current.data.page} totalPages={current.data.totalPages} total={current.data.total} onChange={setPage} />
      ) : null}
    </>
  )
}
